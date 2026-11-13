/**
 * UTF-8 / Hex 工具。
 *
 * 小程序基础库并非所有版本都提供 TextDecoder，而协议要求「对完整 JSON 对象做
 * UTF-8 解码」——SSID 可能含多字节字符，半截解码会得到乱码甚至解析失败。
 * 所以这里自带一份严格的编解码实现。
 */

const REPLACEMENT = 0xfffd;

/** 字符串 -> Uint8Array（正确处理代理对） */
function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(out);
}

/** Uint8Array -> 字符串；截断/非法序列替换为 U+FFFD 而不是抛错 */
function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i + 1 >= len) {
        out += String.fromCharCode(REPLACEMENT);
        i = len;
      } else {
        const b1 = bytes[i + 1];
        if ((b1 & 0xc0) !== 0x80) {
          out += String.fromCharCode(REPLACEMENT);
          i += 1;
        } else {
          out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
          i += 2;
        }
      }
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 2 >= len) {
        out += String.fromCharCode(REPLACEMENT);
        i = len;
      } else {
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
          out += String.fromCharCode(REPLACEMENT);
          i += 1;
        } else {
          out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
          i += 3;
        }
      }
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      if (i + 3 >= len) {
        out += String.fromCharCode(REPLACEMENT);
        i = len;
      } else {
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        const b3 = bytes[i + 3];
        if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) {
          out += String.fromCharCode(REPLACEMENT);
          i += 1;
        } else {
          let cp =
            ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          i += 4;
        }
      }
    } else {
      out += String.fromCharCode(REPLACEMENT);
      i += 1;
    }
  }
  return out;
}

function equals(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

module.exports = { utf8Encode, utf8Decode, equals };
