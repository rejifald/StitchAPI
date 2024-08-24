# StitchAPI

> WARNING: This lib is still under heavy construction. Despite it feedback is appreciated.

StitchAPI is a tool designed to seamlessly integrate (“stitch”) any JSON-based API into your project, simplifying the process of connecting and working with various APIs.

The name StitchAPI combines the words “stitch” and “API,” reflecting its core purpose: to “stitch” or seamlessly connect any JSON-based API into your project. The term “stitch” conveys the idea of binding or linking various APIs into a unified system within your project.

## Features

- **URL Templates** - Supports dynamic URL generation using the [RFC 6570 URI Template specification](https://datatracker.ietf.org/doc/html/rfc6570), allowing for flexible and customizable API endpoint construction.
- **Response unwrap** - Automatically extracts and returns the core data from the API response, simplifying access to the information you need without additional processing.
- **Built-in Query String** - Leverages the [qs](https://www.npmjs.com/package/qs) library to efficiently build and manage query strings, ensuring accurate and consistent URL query parameters.
- **On-the-Fly Validation** - Performs real-time validation of query parameters, request bodies, path parameters, and API responses using the Zod library, ensuring data integrity and type safety throughout every interaction.
- **Flexible Adapters** - Offers the ability to use different HTTP adapters, such as Axios, or even your very own solution, allowing you to choose the best-suited tool for making API requests in your project.

## Installing

### Package manager

Using npm:

```bash
$ npm install stitchapi
```

Using yarn:

```bash
$ yarn add stitchapi
```

Using pnpm:

```bash
$ pnpm add stitchapi
```

Once the package is installed, you can import the library using `import` or `require` approach:

```js
import { stitch } from "stitchapi";
// either
const { stitch } = require("stitchapi");
```

## Example

Create the first stitch

```js
// Assuming we have a GET /api/users endpoint that responds with [{id: 1, name: "John Doe"}, ...]
const findUsers = stitch("/api/users");

// Call it whenever needed to retrieve data from the "stitched" endpoint
const users = await findUsers();
console.log(users); // -> [{id: 1, name: "John Doe"}, ...]
```

Use URL Templates

```js
// Refer to [url-template](https://www.npmjs.com/package/url-template) for advanced templating
const findUser = stitch("/api/users/{id}");

const user = await findUser({ params: { id: 1 } });
console.log(user); // -> {id: 1, name: "John Doe"}
```

Use Query Strings

```js
const findUsers = stitch("/api/users");

const users = await findUsers({
  query: { type: "admin" },
}); // Calls /api/users?type=admin
```

Predefined Query Parameters

> **Note**: Arguments passed as query will overwrite conflicting keys in predefined queries.

```js
const findUsers = stitch("/api/users?sort=name&type=admin");

const users = await findUsers({
  query: { type: "user" },
}); // Will call /api/users?sort=name&type=user
```

Response validation

```js
const findUsers = stitch({
  path: "/api/users?sort=name&type=admin",
  validate: z.object({
    id: z.number(),
    name: z.string(),
  }),
});

await findUsers(); // Will throw an error: Validation error: Expected number, received string at "id"
```

Validating Query, URL Parameters, and Request Body

```js
const findUsers = stitch({
  path: "/api/users?sort=name&type=admin",
  // Specify the validate option with at least one schema. If some schemas are omitted, validation for those components is disabled.
  validate: {
    query: z.object({}),
    params: z.object({}),
    body: z.object({}),
    response: z.object({}),
  },
});
```

Use Different Adapters

```js
import { axiosAdapter } from "stitchapi/lib/adapters/axios";

const findUsers = stitch({
  path: "/api/users?sort=name&type=admin",
  method: "GET",
  adapter: axiosAdapter({
    // Predefined axios parameters
  }),
});
```

> **Note**: Ensure you have axios installed as a dependency.

Unwrap Response Data

```js
// Assuming we have a GET /api/users endpoint that responds with { total: 100, items: [{id: 1, name: "John Doe"}, ...] }
const findUsers = stitch({ path: "/api/users", unwrap: "items" });

// Call it whenever needed to retrieve data from "stitched" endpoint
const users = await findUsers();
console.log(users); // -> [{id: 1, name: "John Doe"}, ...]
```
