import { z } from "zod";
import { stitch } from "../src/stitch";
import { fetch } from "./__mocks__/fetch";

describe("validation", () => {
  beforeEach(() => {
    fetch.mockClear();
    fetch.mockResolvedValue({
      json: async () => ({
        email: "[email protected]",
        id: "123",
        name: "John Doe",
      }),
    } as Response);
  });
  it("Should pass if response is valid", async () => {
    const result = await stitch({
      path: "https://reqres.in/api/users/{id}",
      validate: z.object({
        email: z.string(),
        id: z.string(),
        name: z.string(),
      }),
    })({});

    expect(result).toEqual({
      email: "[email protected]",
      id: "123",
      name: "John Doe",
    });
  });

  it("Should throw if response is invalid", async () => {
    await expect(() =>
      stitch({
        path: "https://reqres.in/api/users/",
        validate: z.object({
          email: z.string(),
          id: z.object({}),
          name: z.string(),
        }),
      })(),
    ).rejects.toEqual(
      new Error('Validation error: Expected object, received string at "id"'),
    );
  });

  it("Should validate query", async () => {
    await expect(() =>
      stitch({
        path: "https://reqres.in/api/users/",
        validate: {
          body: z.object({
            email: z.string(),
            id: z.object({}),
            name: z.string(),
          }),
        },
      })(),
    ).rejects.toEqual(
      new Error(
        'Invalid body, reason: Validation error: Required at "email"; Required at "id"; Required at "name"',
      ),
    );
  });
});
