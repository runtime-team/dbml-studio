/** Descarga un archivo recibido por `fetch`, usando el nombre que indique el servidor. */
export async function downloadResponse(response: Response, fallbackName: string): Promise<void> {
  if (!response.ok) {
    let message = `No se pudo exportar (${response.status})`;
    try { const data = await response.json() as { error?: string }; if (data.error) message = data.error; } catch { /* cuerpo no JSON */ }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
