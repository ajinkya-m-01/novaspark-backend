import { z } from "zod";

export const honeypot = z.string().max(0).optional().or(z.literal(""));

export const contactSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100, "Name must be at most 100 characters"),
  email: z.string().trim().toLowerCase().email("Invalid email address").max(254, "Email must be at most 254 characters"),
  message: z.string().trim().min(10, "Message must be at least 10 characters").max(500, "Message must be at most 500 characters"),
  website: honeypot,
});

export const subscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address").max(254, "Email must be at most 254 characters"),
  website: honeypot,
});
