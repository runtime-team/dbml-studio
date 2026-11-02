/** Error de tamaño que las APIs traducen a HTTP 413. */
export class RequestBodyTooLarge extends Error {
  constructor() { super('Solicitud demasiado grande'); this.name = 'RequestBodyTooLarge'; }
}

/** Lee un cuerpo en streaming y corta al superar el máximo de bytes, incluso sin Content-Length. */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(request, maxBytes));
}
