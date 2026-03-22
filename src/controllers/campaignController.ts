import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';

const CAMPAIGN_ID = 'active';

const campaignSelect = {
  id: true,
  title: true,
  description: true,
  link: true,
  thumbnailUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const getCampaign = async (_req: Request, res: Response): Promise<void> => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: CAMPAIGN_ID },
      select: campaignSelect,
    });

    res.json({ campaign });
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
};

export const upsertCampaign = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { title, description, link, thumbnailUrl } = req.body;

    const campaign = await prisma.campaign.upsert({
      where: { id: CAMPAIGN_ID },
      update: {
        title,
        description,
        link,
        thumbnailUrl,
        updatedById: req.user!.id,
      },
      create: {
        id: CAMPAIGN_ID,
        title,
        description,
        link,
        thumbnailUrl,
        updatedById: req.user!.id,
      },
      select: {
        ...campaignSelect,
        updatedBy: {
          select: {
            id: true,
            username: true,
            role: true,
          },
        },
      },
    });

    res.json({
      message: 'Campaign updated successfully',
      campaign,
    });
  } catch (error) {
    console.error('Upsert campaign error:', error);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
};
