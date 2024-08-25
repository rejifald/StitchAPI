import { z } from "zod";

export const GetUserResponseSchema = z.object({
  support: z.object({
    url: z.string(),
    text: z.string(),
  }),
  data: z.object({
    id: z.number(),
    email: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    avatar: z.string(),
  }),
});
