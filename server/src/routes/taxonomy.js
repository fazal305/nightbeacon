import { Router } from 'express';
import { CATEGORIES } from '../processing/classificationRules.js';

export const taxonomyRouter = Router();

const PRIORITIES = ['high', 'medium', 'low', 'informational'];

// Single source of truth for the classification taxonomy — the frontend
// filter bar reads this instead of hardcoding a copy that could drift from
// classificationRules.js.
taxonomyRouter.get('/', (req, res) => {
  res.json({
    categories: CATEGORIES.map((c) => c.name),
    priorities: PRIORITIES,
  });
});
