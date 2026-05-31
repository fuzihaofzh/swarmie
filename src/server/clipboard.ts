import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface ClipboardImageResult {
  ok: boolean;
  mode: 'remote-clipboard' | 'path' | 'error';
  path?: string;
  error?: string;
}

function safePathPart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return normalized || 'clipboard';
}

function decodeImage(dataBase64: string, mimeType: string): Buffer | null {
  if (!IMAGE_EXTENSIONS[mimeType]) return null;
  const trimmed = dataBase64.trim();
  if (!trimmed || !/^[a-zA-Z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const buffer = Buffer.from(trimmed, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_CLIPBOARD_IMAGE_BYTES) return null;
  return buffer;
}

function saveClipboardImage(sessionId: string, mimeType: string, buffer: Buffer): string {
  const ext = IMAGE_EXTENSIONS[mimeType] ?? 'png';
  const dir = join(homedir(), '.swarmie', 'clipboard', safePathPart(sessionId));
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}-${randomUUID().slice(0, 8)}.${ext}`;
  const path = join(dir, filename);
  writeFileSync(path, buffer);
  return path;
}

function runClipboardOwner(command: string, args: string[], buffer: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const timer = setTimeout(() => {
      // X11 clipboard owners such as xclip may remain alive until the target
      // app reads the selection. Treat a still-running owner as success and
      // detach it so Node does not wait for the paste consumer.
      child.unref();
      finish(true);
    }, 400);
    timer.unref?.();

    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    if (!child.stdin) {
      finish(false);
      return;
    }
    child.stdin.once('error', () => finish(false));
    child.stdin.end(buffer);
  });
}

async function setRemoteImageClipboard(mimeType: string, buffer: Buffer): Promise<boolean> {
  const candidates: Array<{ command: string; args: string[] }> = [];

  if (process.platform === 'linux') {
    candidates.push({ command: 'wl-copy', args: ['--type', mimeType] });
    candidates.push({
      command: 'xclip',
      args: ['-selection', 'clipboard', '-target', mimeType, '-loops', '1', '-i'],
    });
  }

  for (const candidate of candidates) {
    if (await runClipboardOwner(candidate.command, candidate.args, buffer)) {
      return true;
    }
  }
  return false;
}

export async function syncClipboardImageToRemote(
  sessionId: string,
  mimeType: string,
  dataBase64: string,
): Promise<ClipboardImageResult> {
  const buffer = decodeImage(dataBase64, mimeType);
  if (!buffer) {
    return {
      ok: false,
      mode: 'error',
      error: `Unsupported image clipboard payload. Supported types: ${Object.keys(IMAGE_EXTENSIONS).join(', ')}`,
    };
  }

  const path = saveClipboardImage(sessionId, mimeType, buffer);
  if (await setRemoteImageClipboard(mimeType, buffer)) {
    return { ok: true, mode: 'remote-clipboard', path };
  }

  return {
    ok: true,
    mode: 'path',
    path,
    error: 'No usable remote image clipboard command was available',
  };
}
