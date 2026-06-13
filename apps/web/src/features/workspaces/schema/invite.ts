import { z } from "zod";

// Workspace member invite form schema (extracted from members-screen). AS-012: client-side
// email validation (inline) BEFORE the request — a malformed email never reaches the invite
// endpoint. Roles are the workspace roles (admin|member).
export const inviteSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  role: z.enum(["admin", "member"]),
});
export type InviteForm = z.infer<typeof inviteSchema>;
