import { z } from "zod";
import { stitch } from "../src";
import { fetch } from "./__mocks__/fetch";

const GetUsersResponseSchema = z.object({
  page: z.number(),
  per_page: z.number(),
  total: z.number(),
  total_pages: z.number(),
  data: z.array(
    z.object({
      id: z.number(),
      email: z.string(),
      first_name: z.string(),
      last_name: z.string(),
      avatar: z.string(),
    }),
  ),
});

describe("unwrap", () => {
  beforeEach(() => {
    fetch.mockClear();
    fetch.mockResolvedValue({
      json: () => ({
        page: 2,
        per_page: 6,
        total: 12,
        total_pages: 2,
        data: [
          {
            id: 7,
            email: "michael.lawson@reqres.in",
            first_name: "Michael",
            last_name: "Lawson",
            avatar: "https://reqres.in/img/faces/7-image.jpg",
          },
        ],
      }),
    });
  });
  it("Should unwrap response", async () => {
    const response = await stitch({
      path: "https://reqres.in/api/users",
      unwrap: "data",
      validate: {
        response: GetUsersResponseSchema,
      },
    })();

    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    expect(response).toEqual([
      {
        avatar: "https://reqres.in/img/faces/7-image.jpg",
        email: "michael.lawson@reqres.in",
        first_name: "Michael",
        id: 7,
        last_name: "Lawson",
      },
    ]);
  });
});
