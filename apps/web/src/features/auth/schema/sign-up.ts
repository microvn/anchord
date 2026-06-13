import { z } from "zod";

// Sign-up form schema (extracted from sign-up-screen). C-001/AS-001: password must be at
// least 8 characters (mirrors the backend minPasswordLength) so the user gets the rule
// before submit.
export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type SignUpValues = z.infer<typeof signUpSchema>;
