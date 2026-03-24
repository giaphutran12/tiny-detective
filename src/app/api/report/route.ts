import { NextRequest } from "next/server";
import {
  buildAuthorityPacket,
  buildMarketplacePacket,
  generateReportNarrative,
  reportRequestSchema,
} from "@/lib/investigation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = reportRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ error: "Invalid report payload" }, { status: 400 });
  }

  const dossier = parsed.data.caseDossier;
  const packets = {
    marketplacePacket: buildMarketplacePacket(dossier),
    authorityPacket: buildAuthorityPacket(dossier),
  };

  const narratives = await generateReportNarrative(dossier);

  return Response.json({
    ...packets,
    marketplacePacket: {
      ...packets.marketplacePacket,
      narrative: narratives.marketplaceNarrative,
    },
    authorityPacket: {
      ...packets.authorityPacket,
      narrative: narratives.authorityNarrative,
    },
  });
}

