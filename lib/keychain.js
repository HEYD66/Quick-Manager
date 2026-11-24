'use strict';
/**
 * lib/keychain.js — Windows 凭据管理器安全读写封装（支持 UTF-16LE 分片与 SHA-256 校验）
 *
 * 通过 Win32 advapi32.dll (CredReadW / CredWriteW / CredDeleteW / CredEnumerateW)
 * 与 Amazon Quick 桌面端（python-keyring 格式）完全兼容地读写凭据。
 * 所有凭据数据仅通过 stdin/stdout 传递，绝不出现在命令行参数中。
 */

const { execFile, execFileSync } = require('child_process');
const { createHash } = require('crypto');

const MAX_CHUNK_CHARS = 1200;
const CRED_COMMENT = 'Stored using python-keyring';
const inFlightReads = new Map();

const PS_CRED_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$csharp = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class QwmWinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    public class ReadItem {
        public string target;
        public bool found;
        public string valueB64;
        public long lastWritten;
        public int win32Error;
    }

    public class ExistsItem {
        public string target;
        public bool exists;
        public int win32Error;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr pCredential);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWriteW(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr pCredentials);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    private static bool HasControlChars(string s) {
        for (int i = 0; i < s.Length; i++) {
            char c = s[i];
            if ((c < 0x20 && c != '\t' && c != '\r' && c != '\n') || c == 0x7F) return true;
        }
        return false;
    }

    private static string DecodeBlob(byte[] bytes, string comment) {
        if (bytes == null || bytes.Length == 0) return "";
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        if (comment == "Stored using python-keyring" && bytes.Length % 2 == 0) return Encoding.Unicode.GetString(bytes);
        if (bytes.Length % 2 == 0 && Array.IndexOf(bytes, (byte)0) >= 0) return Encoding.Unicode.GetString(bytes);
        try {
            var strictUtf8 = new UTF8Encoding(false, true);
            string decoded = strictUtf8.GetString(bytes);
            if (bytes.Length % 2 == 0 && HasControlChars(decoded)) return Encoding.Unicode.GetString(bytes);
            return decoded;
        } catch {
            return bytes.Length % 2 == 0 ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
        }
    }

    public static ReadItem ReadOne(string target) {
        IntPtr pCred;
        if (!CredReadW(target, 1, 0, out pCred)) {
            return new ReadItem { target = target, found = false, valueB64 = null, lastWritten = 0, win32Error = Marshal.GetLastWin32Error() };
        }
        try {
            var cred = (CREDENTIAL)Marshal.PtrToStructure(pCred, typeof(CREDENTIAL));
            long ft = ((long)cred.LastWritten.dwHighDateTime << 32) | (uint)cred.LastWritten.dwLowDateTime;
            string comment = cred.Comment != IntPtr.Zero ? Marshal.PtrToStringUni(cred.Comment) : null;
            byte[] bytes = new byte[cred.CredentialBlobSize];
            if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero) {
                Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            }
            string text = DecodeBlob(bytes, comment);
            return new ReadItem {
                target = target,
                found = true,
                valueB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(text)),
                lastWritten = ft,
                win32Error = 0
            };
        } finally {
            CredFree(pCred);
        }
    }

    public static ExistsItem ExistsOne(string target) {
        IntPtr pCred;
        if (!CredReadW(target, 1, 0, out pCred)) {
            return new ExistsItem { target = target, exists = false, win32Error = Marshal.GetLastWin32Error() };
        }
        try {
            return new ExistsItem { target = target, exists = true, win32Error = 0 };
        } finally {
            CredFree(pCred);
        }
    }

    public static void WriteOne(string target, string userName, string comment, string valueB64) {
        string text = string.IsNullOrEmpty(valueB64) ? "" : Encoding.UTF8.GetString(Convert.FromBase64String(valueB64));
        byte[] blob = Encoding.Unicode.GetBytes(text);
        IntPtr pTarget = IntPtr.Zero, pUser = IntPtr.Zero, pComment = IntPtr.Zero, pBlob = IntPtr.Zero;
        try {
            pTarget = Marshal.StringToCoTaskMemUni(target);
            if (!string.IsNullOrEmpty(userName)) pUser = Marshal.StringToCoTaskMemUni(userName);
            if (!string.IsNullOrEmpty(comment)) pComment = Marshal.StringToCoTaskMemUni(comment);
            if (blob.Length > 0) {
                pBlob = Marshal.AllocCoTaskMem(blob.Length);
                Marshal.Copy(blob, 0, pBlob, blob.Length);
            }
            var cred = new CREDENTIAL {
                Flags = 0, Type = 1, TargetName = pTarget, Comment = pComment,
                CredentialBlobSize = (uint)blob.Length, CredentialBlob = pBlob,
                Persist = 3, AttributeCount = 0, Attributes = IntPtr.Zero,
                TargetAlias = IntPtr.Zero, UserName = pUser
            };
            if (!CredWriteW(ref cred, 0)) {
                throw new Exception("CredWriteW failed (" + target + "): Win32Error=" + Marshal.GetLastWin32Error());
            }
        } finally {
            if (pTarget != IntPtr.Zero) Marshal.FreeCoTaskMem(pTarget);
            if (pUser != IntPtr.Zero) Marshal.FreeCoTaskMem(pUser);
            if (pComment != IntPtr.Zero) Marshal.FreeCoTaskMem(pComment);
            if (pBlob != IntPtr.Zero) Marshal.FreeCoTaskMem(pBlob);
        }
    }

    public static void DeleteIgnoreMissing(string target) {
        if (!CredDeleteW(target, 1, 0)) {
            int err = Marshal.GetLastWin32Error();
            if (err != 1168) throw new Exception("CredDeleteW failed (" + target + "): Win32Error=" + err);
        }
    }

    public static void CleanupExcessChunks(string baseTarget, int keepCount) {
        uint count;
        IntPtr pCreds;
        if (!CredEnumerateW(null, 0, out count, out pCreds)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) return;
            throw new Exception("CredEnumerateW failed: Win32Error=" + err);
        }
        var toDelete = new List<string>();
        try {
            string prefix = baseTarget + "_chunk_";
            int ptrSize = IntPtr.Size;
            for (int i = 0; i < count; i++) {
                IntPtr pCred = Marshal.ReadIntPtr(pCreds, i * ptrSize);
                var cred = (CREDENTIAL)Marshal.PtrToStructure(pCred, typeof(CREDENTIAL));
                if (cred.Type != 1 || cred.TargetName == IntPtr.Zero) continue;
                string name = Marshal.PtrToStringUni(cred.TargetName);
                if (string.IsNullOrEmpty(name) || !name.StartsWith(prefix, StringComparison.Ordinal)) continue;
                int idx;
                if (int.TryParse(name.Substring(prefix.Length), out idx) && idx >= keepCount) toDelete.Add(name);
            }
        } finally {
            CredFree(pCreds);
        }
        foreach (string name in toDelete) DeleteIgnoreMissing(name);
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp

try {
    $rawInput = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($rawInput)) { throw "empty stdin payload" }
    $req = $rawInput | ConvertFrom-Json
    $op = [string]$req.op

    if ($op -eq "readMany") {
        $items = @()
        foreach ($t in @($req.targets)) { $items += [QwmWinCred]::ReadOne([string]$t) }
        [pscustomobject]@{ ok = $true; items = $items } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }
    if ($op -eq "existsMany") {
        $items = @()
        foreach ($t in @($req.targets)) { $items += [QwmWinCred]::ExistsOne([string]$t) }
        [pscustomobject]@{ ok = $true; items = $items } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }
    if ($op -eq "writeBatch") {
        $user = if ($null -ne $req.userName) { [string]$req.userName } else { "" }
        $comment = if ($null -ne $req.comment) { [string]$req.comment } else { "" }
        foreach ($job in @($req.jobs)) {
            $baseTarget = [string]$job.target
            $chunkB64s = if ($null -ne $job.chunksB64) { @($job.chunksB64) } else { @() }
            [QwmWinCred]::WriteOne($baseTarget, $user, $comment, [string]$job.mainB64)
            for ($i = 0; $i -lt $chunkB64s.Count; $i++) {
                [QwmWinCred]::WriteOne(($baseTarget + "_chunk_" + $i), $user, $comment, [string]$chunkB64s[$i])
            }
            [QwmWinCred]::CleanupExcessChunks($baseTarget, $chunkB64s.Count)
        }
        [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
        exit 0
    }
    if ($op -eq "deleteBatch") {
        foreach ($t in @($req.targets)) {
            $baseTarget = [string]$t
            [QwmWinCred]::DeleteIgnoreMissing($baseTarget)
            [QwmWinCred]::CleanupExcessChunks($baseTarget, 0)
        }
        [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
        exit 0
    }
    throw "unsupported op: $op"
} catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
`;

const PS_SCRIPT_ENCODED = Buffer.from(PS_CRED_SCRIPT, 'utf16le').toString('base64');
const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', PS_SCRIPT_ENCODED];

function runBridgeSync(payload, timeoutMs = 20000) {
  const stdout = execFileSync('powershell.exe', PS_ARGS, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const parsed = JSON.parse(String(stdout || '').trim());
  if (!parsed || !parsed.ok) throw new Error((parsed && parsed.error) || 'Windows 凭据管理器调用失败');
  return parsed;
}

function runBridgeAsync(payload, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      PS_ARGS,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const outStr = String(stdout || '').trim();
        if (outStr) {
          try {
            const parsed = JSON.parse(outStr);
            if (parsed && parsed.ok) return resolve({ ok: true, data: parsed });
            return resolve({ ok: false, error: (parsed && parsed.error) || 'Windows 凭据管理器调用失败' });
          } catch (_) {}
        }
        resolve({ ok: false, error: String(stderr || (err && err.message) || 'Windows 凭据管理器调用失败').trim() });
      }
    );
    if (child.stdin) child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

function decodeB64Utf8(b64) { return b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''; }
function encodeUtf8B64(str) { return Buffer.from(String(str == null ? '' : str), 'utf8').toString('base64'); }

function splitIntoChunks(text, maxChars = MAX_CHUNK_CHARS) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function verifyChunkSha(fullText, expectedSha) {
  if (typeof expectedSha !== 'string' || !expectedSha) return true;
  const h8 = createHash('sha256').update(Buffer.from(fullText, 'utf8')).digest('hex');
  const h16 = createHash('sha256').update(Buffer.from(fullText, 'utf16le')).digest('hex');
  return h8 === expectedSha || h16 === expectedSha;
}

function resolveTargetVariants(serviceName, accountName = 'session') {
  const targets = [serviceName];
  if (accountName && serviceName.startsWith('quickwork-') && !serviceName.includes('@')) {
    targets.push(`${accountName}@${serviceName}`);
  }
  return targets;
}

function getKeychainServiceName(profileId, providerType = 'social') {
  const provider = String(providerType || 'social').trim().toLowerCase() || 'social';
  return `quickwork-${provider}-${profileId}`;
}

/** 批量检查多个 serviceName 是否存在（单次 PowerShell 调用，高效不卡顿） */
async function checkManyKeychainSecrets(serviceNames, accountName = 'session') {
  const out = {};
  if (process.platform !== 'win32' || !Array.isArray(serviceNames) || !serviceNames.length) return out;
  const targetToSvc = new Map();
  const allTargets = [];
  for (const svc of serviceNames) {
    if (!svc) continue;
    out[svc] = false;
    for (const t of resolveTargetVariants(svc, accountName)) {
      if (!targetToSvc.has(t)) {
        targetToSvc.set(t, svc);
        allTargets.push(t);
      }
    }
  }
  if (!allTargets.length) return out;
  const res = await runBridgeAsync({ op: 'existsMany', targets: allTargets });
  if (!res.ok) return null;
  for (const item of (res.data && res.data.items) || []) {
    if (item && item.exists) {
      const svc = targetToSvc.get(item.target);
      if (svc) out[svc] = true;
    }
  }
  return out;
}

async function hasKeychainSecretAsync(serviceName, accountName = 'session') {
  if (process.platform !== 'win32') return { ok: false, exists: false, error: '仅支持 Windows 凭据管理器' };
  if (!serviceName) return { ok: false, exists: false, error: '凭据名称为空' };
  const candidates = resolveTargetVariants(serviceName, accountName);
  const res = await runBridgeAsync({ op: 'existsMany', targets: candidates });
  if (!res.ok) return { ok: false, exists: false, error: res.error };
  const items = (res.data && res.data.items) || [];
  if (items.some((x) => x && x.exists)) return { ok: true, exists: true };
  if (items.length === candidates.length && items.every((x) => x && !x.exists && Number(x.win32Error) === 1168)) {
    return { ok: true, exists: false };
  }
  const bad = items.find((x) => !x || (!x.exists && Number(x.win32Error) !== 1168));
  return { ok: false, exists: false, error: bad ? `Win32Error=${bad.win32Error}` : '凭据检查结果不完整' };
}

async function readKeychainSecretAsync(serviceName) {
  if (process.platform !== 'win32') return { ok: false, value: null, error: '仅支持 Windows 凭据管理器' };
  if (!serviceName) return { ok: false, value: null, error: '凭据名称为空' };
  if (inFlightReads.has(serviceName)) return inFlightReads.get(serviceName);

  const task = (async () => {
    try {
      const candidates = resolveTargetVariants(serviceName, 'session');
      const firstRes = await runBridgeAsync({ op: 'readMany', targets: candidates });
      if (!firstRes.ok) return { ok: false, value: null, error: firstRes.error };

      const foundItems = ((firstRes.data && firstRes.data.items) || []).filter((x) => x && x.found);
      if (!foundItems.length) return { ok: false, value: null, error: 'Windows 凭据管理器中未找到对应凭据' };

      foundItems.sort((a, b) => {
        const diff = Number(b.lastWritten || 0) - Number(a.lastWritten || 0);
        if (diff !== 0) return diff;
        return a.target === serviceName ? -1 : b.target === serviceName ? 1 : 0;
      });

      let lastErr = '分片凭据读取失败';
      for (const item of foundItems) {
        const mainVal = decodeB64Utf8(item.valueB64);
        let parsed = null;
        try { parsed = JSON.parse(mainVal); } catch (_) {}

        if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.__chunks__) && parsed.__chunks__ > 0) {
          const chunkTargets = [];
          for (let i = 0; i < parsed.__chunks__; i++) chunkTargets.push(`${item.target}_chunk_${i}`);
          const chunkRes = await runBridgeAsync({ op: 'readMany', targets: chunkTargets });
          if (!chunkRes.ok) { lastErr = chunkRes.error || lastErr; continue; }
          const chunkItems = (chunkRes.data && chunkRes.data.items) || [];
          if (chunkItems.length !== parsed.__chunks__ || chunkItems.some((c) => !c || !c.found)) {
            lastErr = '分片凭据不完整';
            continue;
          }
          const full = chunkItems.map((c) => decodeB64Utf8(c.valueB64)).join('');
          if (!verifyChunkSha(full, parsed.__sha__)) {
            lastErr = '分片凭据 SHA-256 校验失败';
            continue;
          }
          return { ok: true, value: full };
        }
        return { ok: true, value: mainVal };
      }
      return { ok: false, value: null, error: lastErr };
    } catch (e) {
      return { ok: false, value: null, error: (e && e.message) || String(e) };
    }
  })().finally(() => { inFlightReads.delete(serviceName); });

  inFlightReads.set(serviceName, task);
  return task;
}

function writeKeychainSecret(serviceName, secretString, accountName = 'session') {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows 凭据管理器写入');
  const text = String(secretString == null ? '' : secretString);
  const targets = resolveTargetVariants(serviceName, accountName);

  let mainText = text;
  let chunkTexts = [];
  if (text.length > MAX_CHUNK_CHARS) {
    chunkTexts = splitIntoChunks(text, MAX_CHUNK_CHARS);
    const shaHex = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    mainText = `{"__chunks__": ${chunkTexts.length}, "__sha__": ${JSON.stringify(shaHex)}}`;
  }

  const mainB64 = encodeUtf8B64(mainText);
  const chunksB64 = chunkTexts.map((c) => encodeUtf8B64(c));
  const jobs = targets.map((target) => ({ target, mainB64, chunksB64 }));

  runBridgeSync({
    op: 'writeBatch',
    userName: accountName || 'session',
    comment: CRED_COMMENT,
    jobs,
  });
}

function deleteKeychainSecret(serviceName, accountName = 'session') {
  if (process.platform !== 'win32' || !serviceName) return;
  const targets = resolveTargetVariants(serviceName, accountName);
  try { runBridgeSync({ op: 'deleteBatch', targets }); } catch (_) {}
}

module.exports = {
  getKeychainServiceName,
  checkManyKeychainSecrets,
  hasKeychainSecretAsync,
  readKeychainSecretAsync,
  writeKeychainSecret,
  deleteKeychainSecret,
};
