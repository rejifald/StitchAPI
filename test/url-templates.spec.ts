import { stitch } from "../src";
import fetch from "jest-fetch-mock";
import getUserResponseMock from "./__mocks__/get_user_response.json";

describe("url templates", () => {
  beforeEach(() => {
    fetch.mockResponse(JSON.stringify(getUserResponseMock));
  });

  it("Should resolve url template", () => {
    stitch({ path: "https://reqres.in/api/users/{id}" })({
      params: { id: 1 },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://reqres.in/api/users/1", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  });
});
