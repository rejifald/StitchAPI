<img src="https://github.com/rejifald/StitchAPI/blob/9c65d767e6e2ecff7e0a7a2922843a7cdc38a0b5/docs/media/logo_baner_light.png?raw=true" alt="StitchAPI Logo Banner"/>

---

> WARNING: This lib is still under heavy construction. Despite it feedback is appreciated.

StitchAPI is a tool designed to seamlessly integrate (or “stitch”) any JSON-based API into your project, simplifying the process of integrating any JSON-based APIs.

The name StitchAPI combines the words “stitch” and “API,” reflecting its core purpose: to “stitch” or seamlessly connect any JSON-based API into your project. The term “stitch” conveys the idea of binding or linking various APIs into a unified system within your project.

<div align="center">

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=bugs)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)

[![Discord](https://img.shields.io/discord/1277332872814137505)](https://discord.gg/mAx9RQWN)
[![npm version](https://img.shields.io/npm/v/stitchapi.svg)](https://www.npmjs.org/package/stitchapi)
[![npm downloads](https://img.shields.io/npm/dm/stitchapi.svg)](https://npm-stat.com/charts.html?package=stitchapi)
[![NPM Type Definitions](https://img.shields.io/npm/types/stitchapi)](https://www.npmjs.org/package/stitchapi)

[![Codecov](https://img.shields.io/codecov/c/github/rejifald/stitchapi)](https://codecov.io/github/rejifald/StitchAPI)
![npm bundle size](https://img.shields.io/bundlephobia/minzip/stitchapi)
![Tree Shaking](https://badgen.net/bundlephobia/tree-shaking/stitchapi)

</div>

## Table of Contents

-   [Motivation](#motivation)
-   [Features](#features)
-   [Installing](#installing)
-   [Live example](#live-example)
-   [Example](#example)
-   [Platform agnostic](#platform-agnostic)
-   [URL Templates](#url-templates)
-   [URL Query String Builder](#url-query-string-builder)
-   [Response unwrap](#response-uwnrap)
-   [On-the-Fly Validation](#on-the-fly-validation)
-   [Type Inference](#type-inference)

## Motivation

In almost every project involving HTTP calls, there’s usually a src/api directory filled with simple functions that make HTTP requests using a chosen HTTP library. These functions often do the bare minimum: send an HTTP request and “unwrap” the response.

This project aims to streamline and enhance the process of integrating with APIs by allowing you to declare an endpoint (or “stitch”) and receive a ready-to-use function in return. In essence, this library helps you create a robust and feature-rich API client, or as we like to say, it helps you “stitch” any JSON-based API into your project.

## Features

-   **Platform agnostic** - Works in browser and Node thanks to [cross-fetch](https://www.npmjs.com/package/cross-fetch).
-   **URL Templates** - Supports dynamic URL generation using the [RFC 6570 URI Template specification](https://datatracker.ietf.org/doc/html/rfc6570), allowing for flexible and customizable API endpoint construction.
-   **URL Query String Builder** - Leverages the [qs](https://www.npmjs.com/package/qs) library to efficiently build and manage query strings, ensuring accurate and consistent URL query parameters.
-   **Response unwrap** - Automatically extracts and returns the core data from the API response, simplifying access to the information you need without additional processing.
-   **On-the-Fly Validation** - Performs real-time validation of query parameters, request bodies, path parameters, and API responses using the Zod library, ensuring data integrity and type safety throughout every interaction.
-   **Type Inference** - Automatically generates TypeScript types from your validation schemas, ensuring strong typing and reducing the need for manual type definitions, making your API interactions type-safe and more maintainable.
-   **Flexible Adapters** - Offers the ability to use different HTTP adapters, such as Axios, or even your very own solution, allowing you to choose the best-suited tool for making API requests in your project.
-   **_Coming soon_**: **Code Generation** - Generate API stitches and corresponding TypeScript type definitions directly from your OpenAPI specification.
-   **_Coming soon_**: **Modular structure** - Allows each library component to be bundled separately, providing flexibility and enabling you to include only the specific functionalities you need in your project.

## Installing

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

## Live example

[![Edit StitchAPI Get Users](https://codesandbox.io/static/img/play-codesandbox.svg)](https://codesandbox.io/p/sandbox/stitchapi-get-users-4y7y2d)

## Example

Create the first stitch

```js
import { stitch } from 'stitchapi';

// Refer to https://reqres.in for API description
// Assuming we have a GET https://reqres.in/api/users that responds with
// {
//  "page": 1,
//  "per_page": 10,
//  "total": 12,
//  "total_pages": 2,
//  "data": [
//      {
//          "id": 7,
//          "email": "michael.lawson@reqres.in",
//          "first_name": "Michael",
//          "last_name": "Lawson",
//          "avatar": "https://reqres.in/img/faces/7-image.jpg"
//      },
//   ...
//  ]
// }

const findUsers = stitch('https://reqres.in/api/users');

// Call it whenever needed to retrieve data from the "stitched" endpoint
const users = await findUsers();
console.log(users); // -> JSON response from above
```

Use URL Templates

```js
const findUser = stitch('/api/users/{id}');

const user = await findUser({ params: { id: 1 } });
console.log(user); // -> {id: 1, name: "John Doe"}
```

Use Query Strings

```js
const findUsers = stitch('/api/users');

const users = await findUsers({
    query: { type: 'admin' },
}); // Calls /api/users?type=admin
```

Predefined Query Parameters

> **Note**: Arguments passed as query will overwrite conflicting keys in predefined queries.

```js
const findUsers = stitch('/api/users?sort=name&type=admin');

const users = await findUsers({
    query: { type: 'user' },
}); // Will call /api/users?sort=name&type=user
```

Response validation

```js
const findUsers = stitch({
    path: '/api/users?sort=name&type=admin',
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
    path: '/api/users?sort=name&type=admin',
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
import { axiosAdapter, stitch } from 'stitchapi';

const findUsers = stitch({
    path: '/api/users?sort=name&type=admin',
    method: 'GET',
    adapter: axiosAdapter({
        // Predefined axios parameters
    }),
});
```

> **Note**: Ensure you have axios installed as a dependency.

Unwrap Response Data

```js
// Assuming we have a GET /api/users endpoint that responds with { total: 100, items: [{id: 1, name: "John Doe"}, ...] }
const findUsers = stitch({ path: '/api/users', unwrap: 'items' });

// Call it whenever needed to retrieve data from "stitched" endpoint
const users = await findUsers();
console.log(users); // -> [{id: 1, name: "John Doe"}, ...]
```

## Platform agnostic

In today’s diverse development environments, it’s essential to have tools that work seamlessly across various platforms, whether it’s in the browser, Node.js, or even mobile applications. Ensuring that your API client functions consistently across these environments can be challenging.

Our Platform Agnostic feature addresses this by relying on the [cross-fetch](https://www.npmjs.com/package/cross-fetch) package, a lightweight polyfill that brings the Fetch API to every JavaScript environment. With cross-fetch, your API requests are handled uniformly, regardless of where your code runs.

This means you can build once and deploy anywhere, knowing that your HTTP requests will behave consistently across all platforms. The Platform Agnostic feature ensures that your API client is versatile, reliable, and ready to support a wide range of deployment targets without additional configuration.

## URL Templates

In many cases, URLs are constructed using string literals, such as /api/users/${userId}, which works perfectly fine in most scenarios. However, as your project grows, this approach can become cumbersome, especially when dealing with more complex or dynamic URLs.

This is where URL Templates come in. By leveraging the [RFC 6570 URI Template specification](https://datatracker.ietf.org/doc/html/rfc6570) and the [url-template](https://www.npmjs.com/package/url-template) npm package, this feature allows you to define flexible and reusable URL patterns. Instead of manually concatenating strings, you can define a template like /api/users/{id} and let the library handle the rest.

URL Templates not only make your code cleaner and easier to maintain, but they also reduce the risk of errors in URL construction. They enable you to manage complex routing scenarios effortlessly, whether you’re dealing with optional parameters, query strings, or nested resources.

## URL Query String Builder

In many projects, constructing query strings for URLs is often done manually by concatenating key-value pairs, which can be error-prone and tedious, especially as the number of parameters grows or when dealing with complex query structures.

To simplify this process, our library includes a powerful URL Query String Builder that leverages the [qs](https://www.npmjs.com/package/qs) npm package under the hood. The qs package is a widely used and robust tool for parsing and stringifying query strings, ensuring that your query parameters are accurately encoded and handled.

With the URL Query String Builder, you can easily define query parameters in a clean, declarative manner. The library automatically constructs and appends these parameters to your URLs, whether you’re working with simple queries or more advanced nested structures.

This feature not only reduces boilerplate code but also ensures that your query strings are consistently formatted and compliant with best practices, making your API interactions more reliable and maintainable.

## Response unwrap

When working with APIs, it’s common to receive responses that contain more data than you actually need. Extracting the essential parts of the response often requires repetitive and manual data manipulation, which can clutter your code and introduce errors.

To address this, our Response Unwrap feature simplifies the process by using the [lodash/get](https://lodash.com/docs/4.17.15#get) function to automatically retrieve only the essential part of the response. With this feature, you can specify the exact path to the data you need, and the library will handle the rest, ensuring that you always get the most relevant information without unnecessary boilerplate.

Whether you’re working with deeply nested objects or large payloads, Response Unwrap streamlines your API interactions by focusing on the data that matters most. This leads to cleaner, more maintainable code and reduces the risk of errors when accessing response data.

## On-the-Fly Validation

In API interactions, ensuring that every aspect of a request is valid is crucial for maintaining data integrity and preventing errors. However, manually validating path parameters, query strings, request bodies, and responses can be time-consuming and error-prone.

Our On-the-Fly Validation feature addresses this by allowing you to validate every part of an API request and response in real-time. Leveraging the power of the Zod validation library, this feature lets you define schemas for each component of your request, whether it’s path parameters, query parameters, the request body, or the response itself.

With On-the-Fly Validation, you can ensure that:

-   Path Parameters are correctly formatted and meet required constraints.
-   Query Parameters adhere to expected types and values.
-   Request Bodies contain all necessary fields and conform to your data structure.
-   Responses from the API are exactly as expected, avoiding unexpected data issues downstream.

This comprehensive validation happens automatically as your requests are made, catching potential issues at the earliest possible stage. This leads to more robust, reliable API integrations, reduces debugging time, and enhances the overall quality of your application’s data handling.

## Type Inference

In modern TypeScript projects, maintaining accurate types is key to ensuring code reliability and reducing runtime errors. However, manually defining types for API requests and responses can be tedious and prone to mistakes, especially as your application evolves.

Our Type Inference feature simplifies this process by automatically inferring types directly from your validation schemas. By leveraging the Zod library, this feature ensures that the types used in your code are always in sync with the actual data structures being validated.

Here’s how it works:

-   When you define a validation schema for path parameters, query parameters, request bodies, or responses, Type Inference automatically generates the corresponding TypeScript types.
-   These inferred types are then seamlessly integrated into your code, providing strong typing for your API interactions without the need for manual type definitions.

This not only eliminates the risk of type mismatches but also enhances the developer experience by reducing boilerplate code and making your API calls type-safe by default. With Type Inference, your code becomes more maintainable, and you can confidently refactor your application, knowing that your types are always accurate and up to date.
