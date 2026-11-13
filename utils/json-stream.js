/**
 * CMD TX 通知流 -> JSON 对象。
 *
 * 协议 §4.2：设备按 MTU-3 分片发送，一个通知只是字节片段，不含长度前缀；
 * 客户端必须自己按到达顺序拼字节缓冲，再用括号配对找到完整对象，
 * 并且一个缓冲里可能同时有多个对象（长响应后紧跟 operation.get 响应）。
 *
 * 关键点：配对在「字节」上做，只在拿到完整对象后才解码 UTF-8。
 * 这样 SSID 含中文/emoji 时不会出现半截字符解码失败。
 */

const { utf8Decode } = require('./bytes');

const LBRACE = 0x7b; // {
const RBRACE = 0x7d; // }
const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const MAX_BUFFER = 64 * 1024; // 防御性上限，正常长响应约 1.1KB

class JsonStreamAssembler {
  /**
   * @param {(obj:Object, size:number)=>void} onObject 解析出一个完整 JSON 对象时回调
   *        size = 该对象的原始字节数（不含外部分隔符），供验收做「分片数×片长」交叉校验
   * @param {(err:Error, text:string)=>void} [onError] 对象完整但 JSON.parse 失败时回调
   */
  constructor(onObject, onError) {
    this.buffer = new Uint8Array(0);
    this.onObject = onObject;
    this.onError = onError || function noop() {};
    this.receivedBytes = 0;
    this.objectCount = 0;
  }

  reset() {
    this.buffer = new Uint8Array(0);
  }

  /** 追加一段通知字节并尽可能多地吐出完整对象 */
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.receivedBytes += chunk.length;
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this._drain();
  }

  _drain() {
    for (;;) {
      // 1. 丢弃对象之间的空白/换行，以及任何非 '{' 的杂散字节
      let start = -1;
      for (let i = 0; i < this.buffer.length; i++) {
        const b = this.buffer[i];
        if (b === LBRACE) {
          start = i;
          break;
        }
        // 0x20 空格 0x09 tab 0x0a LF 0x0d CR 视为可丢弃
        if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
          // 既不是空白也不是对象开头：这是噪声，直接跳过
          continue;
        }
      }
      if (start < 0) {
        // 缓冲里没有 '{'，全是噪声/空白，清掉避免无限增长
        this.buffer = new Uint8Array(0);
        return;
      }
      if (start > 0) {
        this.buffer = this.buffer.slice(start);
      }

      // 2. 在字节层面做括号配对（跳过字符串与转义）
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = 0; i < this.buffer.length; i++) {
        const b = this.buffer[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (b === BACKSLASH) {
            escaped = true;
          } else if (b === QUOTE) {
            inString = false;
          }
          continue;
        }
        if (b === QUOTE) {
          inString = true;
        } else if (b === LBRACE) {
          depth += 1;
        } else if (b === RBRACE) {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }

      if (end < 0) {
        // 还没收完，等下一个通知
        if (this.buffer.length > MAX_BUFFER) {
          this.onError(new Error('CMD 缓冲超过上限，已丢弃'), '');
          this.buffer = new Uint8Array(0);
        }
        return;
      }

      // 3. 完整对象：解码 + 解析
      const raw = this.buffer.slice(0, end + 1);
      this.buffer = this.buffer.slice(end + 1);
      const text = utf8Decode(raw);
      try {
        const obj = JSON.parse(text);
        this.objectCount += 1;
        this.onObject(obj, raw.length);
      } catch (err) {
        this.onError(err, text);
      }
    }
  }
}

module.exports = JsonStreamAssembler;
