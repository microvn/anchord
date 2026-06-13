import { z } from "zod";

// Sign-in form schema (extracted from sign-in-screen). Email must be valid; password
// just needs to be present — credential strength is the backend's job, here we only
// guard against an empty submit.
export const signInSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
export type SignInValues = z.infer<typeof signInSchema>;
