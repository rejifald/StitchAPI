export const fetch = jest.fn(() =>
  Promise.resolve({
    json: () =>
      Promise.resolve({
        total: 1,
        error: null,
        success: {
          id: "123",
          name: "John Doe",
          email: "[email protected]",
        },
      }),
  }),
) as jest.Mock;
jest.spyOn(global, "fetch").mockImplementation(fetch);
