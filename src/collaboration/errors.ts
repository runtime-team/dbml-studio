/** Errores con estado HTTP explícito: la API no debe inferir el código a partir del texto del mensaje. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}
export class AccessDenied extends HttpError { constructor(message = 'Acceso denegado') { super(403, message); this.name = 'AccessDenied'; } }
export class NotFound extends HttpError { constructor(message = 'No encontrado') { super(404, message); this.name = 'NotFound'; } }
export class BadRequest extends HttpError { constructor(message: string) { super(400, message); this.name = 'BadRequest'; } }
export class Conflict extends HttpError { constructor(message: string) { super(409, message); this.name = 'Conflict'; } }
export class TooMany extends HttpError { constructor(readonly retryAfterSeconds = 1, message = 'Demasiadas solicitudes. Inténtalo de nuevo en unos segundos.') { super(429, message); this.name = 'TooMany'; } }
