import { z } from "zod";

// Doc-share invite form schema (extracted from invite-row). AS-012/C-006: inline email
// validation BEFORE the request — a malformed email never reaches POST. Roles are the
// doc-share roles (viewer|commenter|editor — never owner, C-004).
export const inviteSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  role: z.enum(["viewer", "commenter", "editor"]),
  message: z.string().optional(),
});
export type InviteForm = z.infer<typeof inviteSchema>;
