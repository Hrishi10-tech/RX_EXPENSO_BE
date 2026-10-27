export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Sign in again.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this.', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (what = 'Item') => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
