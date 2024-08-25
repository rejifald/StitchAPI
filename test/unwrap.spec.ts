import { z } from "zod";
import { stitch } from "../src";
import { fetch } from "./__mocks__/fetch";

describe("unwrap", () => {
  it("Should unwrap response", async () => {
    const unwrappedResult = await stitch({
      path: "https://reqres.in/api/users/{id}",
      unwrap: "success",
      validate: {
        response: z.object({
          success: z.object({
            email: z.string(),
            id: z.string(),
            name: z.string(),
          }),
        }),
        params: z.object({
          id: z.number(),
        }),
      },
    })({
      params: { id: 123 },
    });

    const wrappedResult = await stitch({
      path: "https://reqres.in/api/users/{id}",
    })({
      params: { id: "123" },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users/123", {
      method: "GET",
      body: undefined,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    expect(unwrappedResult).toEqual({
      email: "[email protected]",
      id: "123",
      name: "John Doe",
    });
    expect(wrappedResult).toEqual({
      error: null,
      total: 1,
      success: {
        email: "[email protected]",
        id: "123",
        name: "John Doe",
      },
    });
  });
});
