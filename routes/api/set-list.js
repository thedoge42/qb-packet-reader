import { getSetList } from '../../database/questions.js';

import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
    const setList = getSetList();
    res.json({ setList });
});

export default router;