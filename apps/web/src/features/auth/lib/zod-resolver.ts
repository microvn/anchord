import type { Resolver, FieldValues } from "react-hook-form";
import type { ZodType } from "zod";

// A tiny Zod→RHF resolver. We bind RHF's validation to the Zod schema with safeParse +
// a flat field-map instead of `@hookform/resolvers/zod`, whose 3.x build reads Zod 3's
// error internals (`unionErrors`) and RETHROWS on a Zod 4 error shape — this project is on
// Zod 4. safeParse is version-proof and keeps the form "RHF + Zod" as the stack mandates.
// (Same approach as features/workspaces/members-screen.ts; lifted here for the auth forms.)
export function zodResolver<T extends FieldValues>(schema: ZodType<T>): Resolver<T> {
  return async (values) => {
    const parsed = schema.safeParse(values);
    if (parsed.success) return { values: parsed.data, errors: {} };
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !errors[field]) {
        errors[field] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors: errors as never };
  };
}
