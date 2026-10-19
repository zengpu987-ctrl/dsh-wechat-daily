"""Capture database keys from a re-signed WeChat copy under lldb.

Three hook points, all recorded then auto-continued:
  sqlite3_key(db, pKey, nKey)            -> raw key bytes
  CCKeyDerivationPBKDF(...)              -> password + salt + derived key
  PKCS5_PBKDF2_HMAC(pass, passlen, salt, saltlen, iter, md, keylen, out)
"""
import lldb, json, os

OUT = os.environ.get("WECHAT_KEYSCAN_OUT", "/tmp/wechat-probe/captured-keys.json")
records = []
MAX = 400


def _u(frame, name):
    return frame.FindRegister(name).GetValueAsUnsigned()


def _mem(process, addr, size):
    if not addr or size <= 0:
        return b""
    err = lldb.SBError()
    data = process.ReadMemory(addr, max(1, min(size, 4096)), err)
    return data if err.Success() else b""


def _flush():
    with open(OUT, "w") as f:
        json.dump(records, f, indent=1)


def _add(kind, rec):
    rec = {k: (v.hex() if isinstance(v, (bytes, bytearray)) else v) for k, v in rec.items()}
    rec["kind"] = kind
    records.append(rec)
    if len(records) <= 60 or len(records) % 25 == 0:
        _flush()
        print("HIT %s #%d %s" % (kind, len(records), {k: v for k, v in rec.items() if k != "kind"}), flush=True)


def on_sqlite3_key(frame, bp_loc, internal_dict):
    try:
        p = frame.GetThread().GetProcess()
        db, key_ptr, key_len = _u(frame, "x0"), _u(frame, "x1"), _u(frame, "x2")
        key = _mem(p, key_ptr, key_len)
        if key and len(key) in (16, 32, 48, 64):
            _add("sqlite3_key", {"key": key, "len": len(key), "db": db})
    except Exception as exc:
        print("ERR sqlite3_key %r" % (exc,), flush=True)
    return False


def on_pbkdf_cc(frame, bp_loc, internal_dict):
    try:
        p = frame.GetThread().GetProcess()
        pw_ptr, pw_len = _u(frame, "x1"), _u(frame, "x2")
        salt_ptr, salt_len = _u(frame, "x3"), _u(frame, "x4")
        rounds = _u(frame, "x6")
        dk_ptr = _u(frame, "x7")
        sp = _u(frame, "sp")
        raw = _mem(p, sp, 8)
        dk_len = int.from_bytes(raw[:8].ljust(8, b"\0"), "little")
        _add("cc_pbkdf", {
            "password": _mem(p, pw_ptr, pw_len), "pwLen": pw_len,
            "salt": _mem(p, salt_ptr, salt_len), "saltLen": salt_len,
            "rounds": rounds, "derived": _mem(p, dk_ptr, dk_len), "dkLen": dk_len,
        })
    except Exception as exc:
        print("ERR cc_pbkdf %r" % (exc,), flush=True)
    return False


def on_pbkdf_ossl(frame, bp_loc, internal_dict):
    try:
        p = frame.GetThread().GetProcess()
        pw_ptr, pw_len = _u(frame, "x0"), _u(frame, "x1")
        salt_ptr, salt_len = _u(frame, "x2"), _u(frame, "x3")
        iters = _u(frame, "x4")
        keylen = _u(frame, "x6")
        out_ptr = _u(frame, "x7")
        _add("ossl_pbkdf", {
            "password": _mem(p, pw_ptr, pw_len), "pwLen": pw_len,
            "salt": _mem(p, salt_ptr, salt_len), "saltLen": salt_len,
            "rounds": iters, "derived": _mem(p, out_ptr, keylen), "dkLen": keylen,
        })
    except Exception as exc:
        print("ERR ossl_pbkdf %r" % (exc,), flush=True)
    return False


def install(debugger, target):
    for name, fn in (("sqlite3_key", "capture2.on_sqlite3_key"),
                     ("CCKeyDerivationPBKDF", "capture2.on_pbkdf_cc"),
                     ("PKCS5_PBKDF2_HMAC", "capture2.on_pbkdf_ossl")):
        bp = target.BreakpointCreateByName(name)
        if bp.GetNumLocations():
            bp.SetScriptCallbackFunction(fn)
        print("hook %-24s locations=%d" % (name, bp.GetNumLocations()), flush=True)


def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand("command script add -f capture2.capture_run capture_run")
    install(debugger, debugger.GetSelectedTarget())


def capture_run(debugger, command, result, internal_dict):
    import time
    debugger.SetAsync(True)
    target = debugger.GetSelectedTarget()
    if not any(b.GetNumLocations() for b in target.breakpoint_iter()):
        install(debugger, target)
    process = target.LaunchSimple([], None, None)
    print("launched pid=%s" % (process.GetProcessID() if process else None), flush=True)
    for i in range(20):
        time.sleep(3)
        if len(records) >= MAX:
            break
    _flush()
    print("DONE records=%d state=%s" % (len(records), process.GetState()), flush=True)
    process.Kill()
