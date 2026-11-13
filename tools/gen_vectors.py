#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从权威实现 uart_bridge.py 生成跨语言帧测试向量。

产物：`_verify/pframe-vectors.json`，被 `_verify/pframe-selftest.js` 逐条比对。

为什么要有这个文件
----------------
压测的帧编码在两端各写一遍（小程序 JS / 电脑 Python）。任何一端的
payload 生成、CRC 参数、字节序、字段顺序悄悄改动，都不会立刻报错——
只会在真机上表现为「CRC 全错」或「序号全乱」，然后花几小时怀疑串口。

所以把编码结果**固化成可比对的十六进制**：改一端必红。

约定：不写时间戳，同样的输入必然产出逐字节相同的文件（可进 git diff）。

    python3 tools/gen_vectors.py            # 重新生成
    python3 tools/gen_vectors.py --check    # 校验产物是否与当前实现一致
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import uart_bridge as U  # noqa: E402

OUT_PATH = os.path.normpath(os.path.join(HERE, '..', '..', '_verify', 'pframe-vectors.json'))
STREAM_PATH = os.path.normpath(os.path.join(HERE, '..', '..', '_verify', 'pframe-flood.bin'))
VERSION = 1

# 灌流样本参数：固定值，保证 bin 可复现
STREAM_RUN_ID = 0x4A2B
STREAM_FRAMES = 20
STREAM_PAYLOAD = 191


def build_flood_stream():
    """跑一次真实的 mode_flood，把它写到 socketpair 的字节全部收下来。

    这是跨语言闭环的**源头证据**：不是手工拼字节，而是走 Python 侧实际
    灌流路径产生的数据流。JS 用 FrameParser 解它，能同时验证帧编码、
    速率循环、START/END 位置和 payload 生成四件事。
    """
    import contextlib
    import io
    import socket
    import threading
    import time
    import types

    a, b = socket.socketpair()
    stat = U.Stat()
    args = types.SimpleNamespace(
        port='-', baud=115200, mode='flood', rate=1000000,
        frames=STREAM_FRAMES, len=STREAM_PAYLOAD, delay=0.0,
        run_id=STREAM_RUN_ID, verbose=False,
    )
    sink = io.StringIO()

    def _run():
        with contextlib.redirect_stdout(sink):
            U.mode_flood(b.fileno(), args, stat, lambda: False)

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    data = b''
    a.settimeout(0.5)
    deadline = time.time() + 8.0
    while time.time() < deadline:
        try:
            chunk = a.recv(65536)
            if not chunk:
                break
            data += chunk
        except socket.timeout:
            if not t.is_alive():
                break
    t.join(timeout=5)
    a.close()
    b.close()
    if not data:
        raise SystemExit('灌流样本为空：mode_flood 没有写出任何字节')
    return data


def hexs(b):
    return b.hex()


def build():
    # ---- CRC 向量：含标准 check 值与全 0 / 全 FF 边界 ----
    crc_cases = []
    for name, data in [
        ('empty', b''),
        ('check_123456789', b'123456789'),
        ('single_zero', b'\x00'),
        ('single_ff', b'\xff'),
        ('magic', bytes([U.MAGIC0, U.MAGIC1])),
        ('range_8', bytes(range(8))),
        ('range_256', bytes(range(256))),
        ('all_ff_16', b'\xff' * 16),
    ]:
        crc_cases.append({'name': name, 'hex': hexs(data), 'crc': U.crc16_ccitt(data)})

    # ---- LCG 向量：seq 覆盖 0 / 回绕边界 / 大值（验证 JS Math.imul 精度）----
    lcg_cases = []
    for seq in (0, 1, 2, 42, 255, 256, 65535, 1000000, 2000000000):
        for n in (0, 1, 8, 32, 200):
            lcg_cases.append({'seq': seq, 'n': n, 'hex': hexs(U.lcg_payload(seq, n))})

    # ---- 帧向量 ----
    frames = []

    def add_data(seq, plen):
        fr = U.data_frame(seq, plen)
        frames.append({
            'name': 'data_seq%d_len%d' % (seq, plen),
            'kind': 'data',
            'type': U.TYPE_DATA,
            'seq': seq,
            'payloadLen': plen,
            'hex': hexs(fr),
        })

    for seq in (0, 1, 2, 42, 65535):
        add_data(seq, 11)
    for plen in (0, 1, 191, 200, 2039, 4096):
        add_data(0, plen)

    # 显式 payload：验证 CRC 覆盖范围与二进制安全（0x00 / 0xFF 不能被吃掉）
    for name, payload in [
        ('raw_data_zeros', b'\x00' * 8),
        ('raw_data_ff', b'\xff' * 8),
        ('raw_data_magic_inside', b'\xa5\x5a\xa5\x5a'),
        ('raw_unknown_type', b'\x00\x00'),
    ]:
        ftype = U.TYPE_DATA if name != 'raw_unknown_type' else 0x7f
        frames.append({
            'name': name,
            'kind': 'raw',
            'type': ftype,
            'seq': 3,
            'payloadHex': hexs(payload),
            'hex': hexs(U.build_frame(ftype, 3, payload)),
        })

    for run_id, total, plen in ((0, 500, 200), (7, 1, 11), (0xFFFF, 65535, 191)):
        frames.append({
            'name': 'start_run%d_total%d_len%d' % (run_id, total, plen),
            'kind': 'start',
            'type': U.TYPE_START,
            'seq': run_id,
            'total': total,
            'payloadLen': plen,
            'hex': hexs(U.start_frame(total, plen, run_id)),
        })

    for run_id, sent in ((0, 0), (7, 498), (0xFFFF, 65535)):
        frames.append({
            'name': 'end_run%d_sent%d' % (run_id, sent),
            'kind': 'end',
            'type': U.TYPE_END,
            'seq': run_id,
            'sent': sent,
            'hex': hexs(U.end_frame(sent, run_id)),
        })

    return {
        'version': VERSION,
        'generatedBy': 'tools/gen_vectors.py <- tools/uart_bridge.py',
        'note': '跨语言帧契约。改任一端编码后重新生成并跑 _verify/pframe-selftest.js。',
        'params': {
            'magic': [U.MAGIC0, U.MAGIC1],
            'type': {'DATA': U.TYPE_DATA, 'START': U.TYPE_START, 'END': U.TYPE_END},
            'headerLen': U.HEADER_LEN,
            'crcLen': U.CRC_LEN,
            'overhead': U.FRAME_OVERHEAD,
            'maxPayload': 4096,
            'startPayloadLen': 6,
            'endPayloadLen': 4,
            'crc': {
                'name': 'CRC-16/CCITT-FALSE',
                'poly': 0x1021,
                'init': 0xFFFF,
                'refin': False,
                'refout': False,
                'xorout': 0x0000,
                'check': 0x29B1,
            },
        },
        'crc': crc_cases,
        'lcg': lcg_cases,
        'frames': frames,
    }


def dump(doc):
    return json.dumps(doc, indent=2, ensure_ascii=False) + '\n'


def main(argv):
    doc = build()
    text = dump(doc)
    stream = build_flood_stream()

    if '--check' in argv:
        ok = True
        if not os.path.exists(OUT_PATH):
            print('缺少 %s，请先运行 python3 tools/gen_vectors.py' % OUT_PATH)
            return 1
        with open(OUT_PATH, 'r', encoding='utf-8') as f:
            if f.read() != text:
                print('向量已过期：%s 与当前 uart_bridge.py 不一致' % OUT_PATH)
                ok = False
        if not os.path.exists(STREAM_PATH):
            print('缺少 %s，请先运行 python3 tools/gen_vectors.py' % STREAM_PATH)
            return 1
        with open(STREAM_PATH, 'rb') as f:
            if f.read() != stream:
                print('灌流样本已过期：%s 与当前 mode_flood 不一致' % STREAM_PATH)
                ok = False
        if not ok:
            return 1
        print('向量一致：%d 条 CRC · %d 条 LCG · %d 条帧 · 灌流样本 %dB'
              % (len(doc['crc']), len(doc['lcg']), len(doc['frames']), len(stream)))
        return 0

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        f.write(text)
    with open(STREAM_PATH, 'wb') as f:
        f.write(stream)
    print('已写入 %s' % OUT_PATH)
    print('已写入 %s（%dB）' % (STREAM_PATH, len(stream)))
    print('  CRC %d 条 · LCG %d 条 · 帧 %d 条'
          % (len(doc['crc']), len(doc['lcg']), len(doc['frames'])))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
