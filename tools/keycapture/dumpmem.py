"""Dump every readable memory region of the attached process to one file,
with a JSON sidecar mapping region offsets -> addresses."""
import lldb, json, os

OUT = os.environ.get("WECHAT_MEM_OUT", "/tmp/wechat-probe/mem.bin")
META = OUT + ".regions.json"
CHUNK = 8 << 20
MAX_TOTAL = int(os.environ.get("WECHAT_MEM_MAX", str(6 << 30)))


def _regions(process):
    try:
        regs = process.GetMemoryRegions()
        out = []
        for i in range(regs.GetSize()):
            info = lldb.SBMemoryRegionInfo()
            if regs.GetMemoryRegionAtIndex(i, info):
                out.append(info)
        if out:
            return out
    except Exception:
        pass
    out, addr = [], 0x0
    while True:
        info = lldb.SBMemoryRegionInfo()
        err = process.GetMemoryRegionInfo(addr, info)
        if not err.Success():
            break
        out.append(info)
        nxt = info.GetRegionEnd()
        if nxt <= addr:
            break
        addr = nxt
    return out


def wechat_dump_mem(debugger, command, result, internal_dict):
    try:
        process = debugger.GetSelectedTarget().GetProcess()
        regions = _regions(process)
        meta, total = [], 0
        with open(OUT, "wb") as f:
            for info in regions:
                if not info.IsReadable():
                    continue
                base, end = info.GetRegionBase(), info.GetRegionEnd()
                size = end - base
                if size <= 0 or size > (3 << 30) or total > MAX_TOTAL:
                    continue
                written = 0
                addr = base
                while addr < end:
                    n = min(CHUNK, end - addr)
                    err = lldb.SBError()
                    data = process.ReadMemory(addr, n, err)
                    if err.Success() and data and len(data) == n:
                        f.write(data)
                        written += n
                    addr += n
                if written:
                    meta.append({"offset": total, "addr": base, "size": written,
                                 "writable": info.IsWritable()})
                    total += written
        json.dump(meta, open(META, "w"))
        print("DUMP bytes=%d regions=%d -> %s" % (total, len(meta), OUT), flush=True)
    except Exception as exc:
        print("DUMP_ERROR %r" % (exc,), flush=True)


def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand("command script add -f dumpmem.wechat_dump_mem wechat_dump_mem")
