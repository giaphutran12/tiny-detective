import { NextRequest } from "next/server";
import {
  investigateRequestSchema,
  createInvestigationStream,
  iterateInvestigation,
} from "@/lib/investigation";

export const runtime = "nodejs";

const headers = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = investigateRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid investigate payload" },
      { status: 400 },
    );
  }

  const { officialUrl } = parsed.data;
  const stream = createInvestigationStream(iterateInvestigation(officialUrl));

  return new Response(stream, { headers });
}
