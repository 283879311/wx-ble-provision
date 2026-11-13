#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UART1 回显 / 监听 / 灌流桥 —— BLE x UART 压测的电脑侧对端。

只做三件机械事：回显、计数、按速率灌流。
**不做任何判定** —— 逐字节比对与 PASS/FAIL 全部由小程序算。

用法
----
    # L1 回显：收到什么原样写回（UART 闭环完整性 + RTT）
    python3 uart_bridge.py /dev/ttyUSB1 --baud 115200 --mode echo

    # L0 只监听：不回写，只报累计字节（UART 单向到达率）
    python3 uart_bridge.py /dev/ttyUSB1 --baud 115200 --mode listen

    # L2 灌流：按 PST 帧主动向下行灌数据（手机接收吞吐 / data_pipe 满载）
    python3 uart_bridge.py /dev/ttyUSB1 --baud 115200 --mode flood \
        --rate 4000 --frames 500 --len 200 --delay 5

灌流的时序：延 --delay 秒 → 发 START 帧（带预期帧数）→ 逐帧发 → 发 END 帧（带实际发送数）。
手机端靠 START/END 就能自己结算满额与丢失，不需要电脑告诉它"该收多少"。

零第三方依赖（只用 termios / select / os），Linux 直接可跑。
"""

import argparse
import errno
import os
import select
import struct
import sys
import termios
import time
import signal

# ---------------------------------------------------------------- 帧格式

MAGIC0 = 0xA5
MAGIC1 = 0x5A

TYPE_DATA = 0x01
TYPE_START = 0x02
TYPE_END = 0x03

HEADER_LEN = 7          # magic(2) + type(1) + seq(2) + len(2)
CRC_LEN = 2
FRAME_OVERHEAD = HEADER_LEN + CRC_LEN   # 9


def crc16_ccitt(data):
    """CRC-16/CCITT-FALSE：init 0xFFFF, poly 0x1021, 不反射, 不 xorout。"""
    crc = 0xFFFF
    for b in data:
        crc ^= (b & 0xFF) << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def lcg_payload(seq, n):
    """确定性伪随机载荷：同一 seq 在两端生成完全相同的字节。

    必须与小程序端严格一致。JS 侧要用 Math.imul，不能直接 x*1103515245
    —— x 可达 2^31，乘积约 2.4e18 超过 2^53，会丢精度导致两端 CRC 全错。
    """
    if n <= 0:
        return b''
    x = (seq * 1103515245 + 12345) & 0x7FFFFFFF
    out = bytearray(n)
    for i in range(n):
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        out[i] = (x >> 16) & 0xFF
    return bytes(out)


def build_frame(ftype, seq, payload):
    """组一帧：magic(2) type(1) seq(2) len(2) payload crc16(2)。"""
    head = struct.pack('>BBBHH', MAGIC0, MAGIC1, ftype, seq & 0xFFFF, len(payload))
    # CRC 覆盖 type..payload（不含 magic），便于重同步后直接校验
    body = bytes([ftype]) + struct.pack('>HH', seq & 0xFFFF, len(payload)) + payload
    return head + payload + struct.pack('>H', crc16_ccitt(body))


def data_frame(seq, payload_len):
    return build_frame(TYPE_DATA, seq, lcg_payload(seq, payload_len))


def start_frame(total, payload_len, run_id=0):
    """total = 预期 **DATA 帧数**（不含 START/END 自身）。

    控制帧的 seq 字段填 run_id（轮次号），不参与 DATA 序号空间。接收端只接受
    run_id 与自己当前轮次一致的 START/END —— 否则上一轮迟到的 END 会被当成
    本轮的结束信号，结算出一个假的 100%。
    """
    return build_frame(TYPE_START, run_id & 0xFFFF,
                       struct.pack('>IH', total & 0xFFFFFFFF, payload_len & 0xFFFF))


def end_frame(sent, run_id=0):
    return build_frame(TYPE_END, run_id & 0xFFFF, struct.pack('>I', sent & 0xFFFFFFFF))


# ---------------------------------------------------------------- 串口

BAUD_CONST = {}
for _name in ('B9600', 'B19200', 'B38400', 'B57600', 'B115200', 'B230400',
              'B460800', 'B921600', 'B1000000'):
    if hasattr(termios, _name):
        BAUD_CONST[int(_name[1:])] = getattr(termios, _name)


def open_port(path, baud):
    if baud not in BAUD_CONST:
        raise SystemExit('不支持的波特率 %d（支持：%s）'
                         % (baud, ' '.join(str(b) for b in sorted(BAUD_CONST))))

    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)

    # raw 模式：二进制数据里可能出现 0x00 / 0xFF，任何行规程处理都会破坏字节流
    attrs[0] = 0                                  # iflag: 关 ICRNL / IXON / IXOFF
    attrs[1] = 0                                  # oflag: 关 OPOST
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    attrs[3] = 0                                  # lflag: 关 ICANON / ECHO / ISIG
    attrs[4] = BAUD_CONST[baud]
    attrs[5] = BAUD_CONST[baud]
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def write_all(fd, data, timeout=3.0):
    """非阻塞 fd 上的完整写入：缓冲满时等可写，而不是丢数据。"""
    view = memoryview(data)
    sent = 0
    while sent < len(view):
        try:
            sent += os.write(fd, view[sent:])
        except BlockingIOError:
            _, w, _ = select.select([], [fd], [], timeout)
            if not w:
                raise TimeoutError('串口写超时（对端未读取？）')
        except OSError as e:
            if e.errno == errno.EAGAIN:
                _, w, _ = select.select([], [fd], [], timeout)
                if not w:
                    raise TimeoutError('串口写超时（对端未读取？）')
            else:
                raise
    return sent


def read_ready(fd, timeout):
    r, _, _ = select.select([fd], [], [], timeout)
    if not r:
        return b''
    try:
        return os.read(fd, 4096)
    except BlockingIOError:
        return b''


# ---------------------------------------------------------------- 统计

class Stat(object):
    def __init__(self):
        self.t0 = time.monotonic()
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.rx_peak = 0
        self._last_t = self.t0
        self._last_rx = 0
        self._last_tx = 0

    def rate_line(self, tag):
        now = time.monotonic()
        dt = max(1e-6, now - self._last_t)
        rx = self.rx_bytes - self._last_rx
        tx = self.tx_bytes - self._last_tx
        self._last_t, self._last_rx, self._last_tx = now, self.rx_bytes, self.tx_bytes
        return ('[%6.1fs] %-6s rx %8dB (%7.1f B/s)  tx %8dB (%7.1f B/s)  peak_rx %dB'
                % (now - self.t0, tag, self.rx_bytes, rx / dt,
                   self.tx_bytes, tx / dt, self.rx_peak))

    def summary(self):
        dt = max(1e-6, time.monotonic() - self.t0)
        return ('总计 %.1fs · rx %d B (平均 %.0f B/s) · tx %d B (平均 %.0f B/s)'
                % (dt, self.rx_bytes, self.rx_bytes / dt,
                   self.tx_bytes, self.tx_bytes / dt))


# ---------------------------------------------------------------- 三种模式

def mode_echo(fd, args, stat, stop):
    """收到即原样写回。绝不攒批 —— 攒批会把 PC 侧缓冲延迟算进手机的 RTT。"""
    print('回显中（Ctrl-C 停止）…')
    next_report = time.monotonic() + 1.0
    while not stop():
        chunk = read_ready(fd, 0.2)
        if chunk:
            stat.rx_bytes += len(chunk)
            stat.rx_peak = max(stat.rx_peak, len(chunk))
            if args.verbose:
                print('  rx %dB: %s' % (len(chunk), chunk[:16].hex(' ')))
            write_all(fd, chunk)
            stat.tx_bytes += len(chunk)
        if time.monotonic() >= next_report:
            print(stat.rate_line('echo'))
            next_report += 1.0


def mode_listen(fd, args, stat, stop):
    """只计数不回写：签收 UART 单向到达量。"""
    print('监听中（不回写，Ctrl-C 停止）…')
    next_report = time.monotonic() + 1.0
    while not stop():
        chunk = read_ready(fd, 0.2)
        if chunk:
            stat.rx_bytes += len(chunk)
            stat.rx_peak = max(stat.rx_peak, len(chunk))
            if args.verbose:
                print('  rx %dB: %s' % (len(chunk), chunk[:16].hex(' ')))
        if time.monotonic() >= next_report:
            print(stat.rate_line('listen'))
            next_report += 1.0


def mode_flood(fd, args, stat, stop):
    """按 PST 帧主动灌下行：START → 数据帧 → END。

    速率用"目标字节/秒"控制；若 UART 或对端吃不消，实际速率会低于目标，
    这本身就是有效信息（说明链路饱和），结束时一并报出来。
    """
    if args.delay > 0:
        print('%.1fs 后开始灌流 —— 现在去手机上点「开始监听」…' % args.delay)
        time.sleep(args.delay)

    frames = max(1, args.frames)
    plen = max(1, args.len)
    frame_len = FRAME_OVERHEAD + plen
    rate = max(64, args.rate)
    # 轮次号：默认取时间低位，保证每轮不同（防止跨轮 END 被误认作本轮结束）
    run_id = args.run_id & 0xFFFF if args.run_id >= 0 else (int(time.time()) & 0xFFFF)

    print('灌流：%d 帧 x %dB(载荷 %dB) · 目标 %d B/s · UART %d 8N1 · runId=0x%04X'
          % (frames, frame_len, plen, rate, args.baud, run_id))

    write_all(fd, start_frame(frames, plen, run_id))
    stat.tx_bytes += FRAME_OVERHEAD + 6

    started = time.monotonic()
    next_at = started
    sent = 0
    for i in range(frames):
        if stop():
            break
        write_all(fd, data_frame(i, plen))
        stat.tx_bytes += frame_len
        sent += 1

        next_at += frame_len / float(rate)
        ahead = next_at - time.monotonic()
        if ahead > 0:
            time.sleep(ahead)

        if (i + 1) % 200 == 0:
            print(stat.rate_line('flood'))

    write_all(fd, end_frame(sent, run_id))
    stat.tx_bytes += FRAME_OVERHEAD + 4

    elapsed = time.monotonic() - started
    actual = sent * frame_len / max(1e-6, elapsed)
    print('灌流结束：%d 帧 · 实发 %d B · 耗时 %.2fs · 实际 %.0f B/s（目标 %d B/s）'
          % (sent, sent * frame_len, elapsed, actual, rate))
    # 少量帧时 elapsed 趋近 0，速率算不出意义，不做饱和判断（避免误报）
    if sent >= 20 and elapsed >= 0.2 and actual < rate * 0.9:
        print('  注意：实际速率显著低于目标 → UART 侧或 BLE 下行已饱和')
    print('  已发 END 帧（sent=%d），手机端据此结算满额与丢失。' % sent)

    # 灌完后继续读一会，避免残留数据堆在驱动里
    tail_until = time.monotonic() + 1.5
    while time.monotonic() < tail_until and not stop():
        chunk = read_ready(fd, 0.2)
        if chunk:
            stat.rx_bytes += len(chunk)


# ---------------------------------------------------------------- 入口

def main(argv):
    p = argparse.ArgumentParser(
        description='BLE x UART 压测的电脑侧对端（只回显/计数/灌流，不做判定）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='示例：python3 uart_bridge.py /dev/ttyUSB1 --mode flood --rate 4000 --frames 500 --len 200')
    p.add_argument('port', help='串口设备，如 /dev/ttyUSB1（ESP UART1 TX/RX）')
    p.add_argument('--baud', type=int, default=115200, help='波特率，默认 115200')
    p.add_argument('--mode', choices=['echo', 'listen', 'flood'], default='echo',
                   help='echo=回显(默认) / listen=只计数 / flood=向下行灌流')
    p.add_argument('--rate', type=int, default=4000, help='flood 目标速率 B/s，默认 4000')
    p.add_argument('--frames', type=int, default=500, help='flood 帧数，默认 500')
    p.add_argument('--len', type=int, default=200, help='flood 每帧载荷字节数，默认 200')
    p.add_argument('--delay', type=float, default=5.0, help='flood 开始前等待秒数，默认 5')
    p.add_argument('--run-id', type=int, default=-1,
                   help='flood 轮次号 0..65535，默认取时间低位；手机端需与之一致')
    p.add_argument('--verbose', action='store_true', help='打印每批收到的前 16 字节')
    args = p.parse_args(argv)

    try:
        fd = open_port(args.port, args.baud)
    except OSError as e:
        raise SystemExit('打开 %s 失败：%s' % (args.port, e))

    stat = Stat()
    state = {'stop': False}

    def on_sigint(signum, _frame):
        state['stop'] = True

    signal.signal(signal.SIGINT, on_sigint)
    signal.signal(signal.SIGTERM, on_sigint)

    print('%s 已打开 · %d 8N1 · 模式 %s' % (args.port, args.baud, args.mode))
    try:
        if args.mode == 'echo':
            mode_echo(fd, args, stat, lambda: state['stop'])
        elif args.mode == 'listen':
            mode_listen(fd, args, stat, lambda: state['stop'])
        else:
            mode_flood(fd, args, stat, lambda: state['stop'])
    except (TimeoutError, OSError) as e:
        print('\n中断：%s' % e, file=sys.stderr)
    finally:
        print(stat.summary())
        try:
            os.close(fd)
        except OSError:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
