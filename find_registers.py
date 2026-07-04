# Locate the Modbus_FB supervisor block by matching known current values from the
# c.pCO web page against a register scan. The web "ID" column is the internal PLC
# variable index, NOT the Modbus address — this finds the real addresses.
# Run:  CHILLER_IP=192.168.1.69 ./.venv/bin/python find_registers.py
import os
from pymodbus.client import ModbusTcpClient

HOST = os.environ.get("CHILLER_IP", "192.168.1.69")
MAXADDR = int(os.environ.get("SCAN_MAX", "2000"))  # PDU addresses 0..MAXADDR

# Distinctive current values pulled from the Modbus_FB block on the web page.
# Pick ones unlikely to collide (4-digit raws are best anchors).
TARGETS = {
    "DscgPA (236.9)": 236.9, "DscgPB (210.3)": 210.3,
    "SuctPA (29.01)": 29.01, "SuctPB (31.91)": 31.91,
    "SuctTA (34.34)": 34.34, "SuctTB (47.66)": 47.66,
    "GlyInTemp (27.99)": 27.99, "GlyOutTemp (27.60)": 27.60,
    "GlyResTemp (28.19)": 28.19, "GlySupPres (12.53)": 12.53,
    "EEVPosA (37.5)": 37.5, "FanSpA (59.4)": 59.4, "EvapPDA (9.81)": 9.81,
}


def scan(client, reader, label):
    """Read reader() in 100-reg chunks; return {pdu_addr: raw_uint16}."""
    out = {}
    for base in range(0, MAXADDR, 100):
        rr = reader(address=base, count=100, device_id=1)
        if rr.isError():
            continue  # illegal address range on this map — skip
        for i, v in enumerate(rr.registers):
            out[base + i] = v
    return out


def matches(regs, target):
    # CAREL analog = signed int16 ×10 (sometimes ×100). Try both.
    hits = []
    for addr, raw in regs.items():
        s = raw - 65536 if raw > 32767 else raw
        if abs(s / 10 - target) < 0.05 or abs(s / 100 - target) < 0.005:
            hits.append((addr, raw))
    return hits


def main():
    c = ModbusTcpClient(HOST, timeout=5)
    if not c.connect():
        print("connect failed")
        return
    try:
        holding = scan(c, c.read_holding_registers, "holding")
        inputs = scan(c, c.read_input_registers, "input")
    finally:
        c.close()
    for name, tgt in TARGETS.items():
        h = matches(holding, tgt)
        i = matches(inputs, tgt)
        loc = ", ".join(f"HOLD@{a}(raw {r})" for a, r in h) or ""
        loc += ("; " if h and i else "") + ", ".join(f"INPUT@{a}(raw {r})" for a, r in i)
        print(f"{name:24} -> {loc or 'no match'}")

    # Full dump of the live INPUT block for hand-correlation against the web page.
    print("\n--- INPUT registers 0..64 (addr: raw = raw/10) ---")
    for addr in range(0, 65):
        raw = inputs.get(addr)
        if raw is None:
            continue
        s = raw - 65536 if raw > 32767 else raw
        print(f"  INPUT@{addr:<3} raw={raw:<6} /10={s/10}")


if __name__ == "__main__":
    # matching logic self-check (no device needed)
    assert matches({5: 2369}, 236.9) == [(5, 2369)]
    assert matches({7: 65516}, -2.0) == [(7, 65516)]  # signed
    main()
