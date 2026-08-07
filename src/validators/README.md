# src/validators

Zod schemas that validate incoming request bodies, params and query strings.
One file per resource, named `<entity>.validator.js`.

Validation runs at the edge of the application so controllers and services can
assume their input is already well-formed. `zod` is installed and the error
handler already converts a `ZodError` into a 422 response with field-level
detail, so a validator only needs to be written and mounted.
