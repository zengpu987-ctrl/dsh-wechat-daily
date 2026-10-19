"""lldb command script: launch the re-signed WeChat copy, let it open its DBs,
then scan its memory for WCDB key material written as x'<64hex key><32hex salt>'."""
import lldb, time, re, json, os, sys

EXE = os.environ.get("WECHAT_PROBE_EXE", "")
OUT = os.environ.get("WECHAT_KEYSCAN_OUT", "/tmp/wechat-keys-candidates.json")
WAIT = float(os.environ.get("WECHAT_PROBE_WAIT", "45"))
PATTERN = re.compile(rb"([0-9a-fA-F]{64})([0-9a-fA-F]{32})")
CHUNK = 4 << 20


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


def _scan(process, hits):
    for info in _regions(process):
        if not info.IsReadable():
            continue
        base, end = info.GetRegionBase(), info.GetRegionEnd()
        if end <= base or (end - base) > (8 << 30):
            continue
        addr = base
        while addr < end:
            n = min(CHUNK, end - addr)
            err = lldb.SBError()
            data = process.ReadMemory(addr, n, err)
            if err.Success() and data:
                for m in PATTERN.finditer(data):
                    hits[m.group(2).decode().lower()] = m.group(1).decode().lower()
            addr += n
    return hits


def wechat_capture(debugger, command, result, internal_dict):
    try:
        debugger.SetAsync(True)
        target = debugger.CreateTarget(EXE)
        if not target:
            print("CAPTURE_FAIL no target: %s" % EXE)
            return
        print("CAPTURE launching %s" % EXE, flush=True)
        err = lldb.SBError()
        process = target.LaunchSimple([], None, None)
        if process is None or not process.IsValid():
            print("CAPTURE_FAIL launch: %s" % err.GetCString())
            return
        print("CAPTURE pid=%d, waiting %.0fs for login + db open" % (process.GetProcessID(), WAIT), flush=True)
        time.sleep(WAIT)
        if process.GetState() == lldb.eStateExited:
            print("CAPTURE_FAIL process exited during wait")
            return
        process.Stop()
        deadline = time.time() + 15
        while process.GetState() != lldb.eStateStopped and time.time() < deadline:
            time.sleep(0.2)
        print("CAPTURE state=%s, scanning" % process.GetState(), flush=True)
        hits = _scan(process, {})
        with open(OUT, "w") as f:
            json.dump(hits, f)
        print("CAPTURE candidates=%d -> %s" % (len(hits), OUT), flush=True)
        process.Kill()
    except Exception as exc:
        print("CAPTURE_ERROR %r" % (exc,), flush=True)


def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand("command script add -f scan.wechat_capture wechat_capture")
    debugger.HandleCommand("command script add -f scan.wechat_scan_current wechat_scan_current")


def wechat_scan_current(debugger, command, result, internal_dict):
    """Scan the process lldb is already attached to (no launch)."""
    try:
        process = debugger.GetSelectedTarget().GetProcess()
        print("SCAN pid=%d state=%s" % (process.GetProcessID(), process.GetState()), flush=True)
        hits = _scan(process, {})
        with open(OUT, "w") as f:
            json.dump(hits, f)
        print("SCAN candidates=%d -> %s" % (len(hits), OUT), flush=True)
    except Exception as exc:
        print("SCAN_ERROR %r" % (exc,), flush=True)


def __lldb_init_module2(debugger, internal_dict):
    pass
