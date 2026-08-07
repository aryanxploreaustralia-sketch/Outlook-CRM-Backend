/**
 * Wraps an async route handler so rejections reach the error middleware safely.
 *
 * A note on why this still exists under Express 5: unlike Express 4, Express 5
 * *does* forward a rejected promise from a handler to `next()` automatically, so
 * this wrapper is not needed merely to catch async errors.
 *
 * It earns its place by normalising the rejection *value*. JavaScript allows
 * throwing anything — `throw 'nope'`, `Promise.reject(null)` — and Express
 * forwards that value untouched. The error handler would then read `.statusCode`
 * and `.stack` off a string or null and misbehave. Wrapping every non-Error
 * rejection into a real Error guarantees the handler always receives an object
 * with the properties it relies on.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} handler
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch((error) => {
      if (error instanceof Error) {
        next(error)
        return
      }

      const normalised = new Error(
        `Route handler rejected with a non-Error value: ${JSON.stringify(error) ?? String(error)}`,
      )
      normalised.cause = error
      next(normalised)
    })
  }
}

export default asyncHandler
