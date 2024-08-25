import { z } from "zod";

export const GetUsersResponseSchema = z.object({
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
