import { stitch } from "../src";
import fetch from "jest-fetch-mock";
import getUsersResponseMock from "./__mocks__/get_users_response.json";

describe("qs", () => {
  beforeEach(() => {
    fetch.mockResponse(JSON.stringify(getUsersResponseMock));
  });
  it("Should return stitched function with query string", async () => {
    const stitched = stitch("https://reqres.in/api/users");

    await stitched({
      query: {
        page: 2,
      },
    });

    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users?page=2", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  });

  it("Should keep predefined query string", async () => {
    const stitched = stitch({
      path: "https://reqres.in/api/users?per_page=10",
    });

    await stitched({
      query: {
        per_page: 10,
        page: 1,
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://reqres.in/api/users?per_page=10&page=1",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("Should override conflicting query keys", async () => {
    const stitched = stitch({
      path: "https://reqres.in/api/users?per_page=10",
    });

    await stitched({
      query: {
        per_page: 20,
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://reqres.in/api/users?per_page=20",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
    );
  });
});
