import { Router } from 'express';
import { body, query } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { authenticate, requirePermission, enforcePasswordChange } from '../middleware/auth.js';
import { validate } from '../middleware/validator.js';
import * as samChatController from '../controllers/samChat.controller.js';

const router = Router();

/**
 * The assistant's own mark.
 *
 * It is served before the authentication middleware, and deliberately so: the
 * browser fetches it as an image, and an image request carries no bearer
 * token. The file is the assistant's mark and nothing else -- it holds no
 * record about a person, no patient data and no configuration -- so serving
 * it without a sign-in discloses nothing. Every other path on this router is
 * behind the authentication middleware.
 */
router.get(
  '/profile-image/file/:itemId/:fileName',
  samChatController.getProfileImageFile
);

router.use(authenticate);
router.use(enforcePasswordChange);

/**
 * Each turn is an outbound model request, which is the most expensive thing
 * the API does per call, so the chat has its own ceiling on top of the
 * global per-IP limiter.
 */
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.SAM_RATE_LIMIT_MAX || '20'),
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many support requests from this IP, please try again later',
});

/** The largest profile image the service accepts. */
const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROFILE_IMAGE_BYTES },
});

const chatValidators = [
  body('messages')
    .isArray({ min: 1, max: 50 })
    .withMessage('messages must be an array of 1 to 50 entries'),
  body('messages.*.role')
    .isString()
    .withMessage('each message needs a role')
    .bail()
    .isLength({ max: 32 }),
  body('messages.*.content')
    .isString()
    .withMessage('each message needs content')
    .bail()
    .isLength({ min: 1, max: 8000 })
    .withMessage('each message must be at most 8000 characters'),
  body('currentPage')
    .optional({ nullable: true })
    .isString()
    .withMessage('currentPage must be a string')
    .bail()
    .isLength({ max: 500 })
    .withMessage('currentPage must be at most 500 characters'),
];

const configValidators = [
  body('enabled')
    .optional({ nullable: true })
    .isBoolean()
    .withMessage('enabled must be a boolean'),
  body('provider')
    .optional({ nullable: true })
    .isString()
    .withMessage('provider must be a string')
    .bail()
    .isIn(samChatController.knownProviders())
    .withMessage('provider is not a known provider'),
  body('model')
    .optional({ nullable: true })
    .isString()
    .withMessage('model must be a string')
    .bail()
    .isLength({ max: 120 })
    .withMessage('model must be at most 120 characters'),
  body('fallbackProvider')
    .optional({ nullable: true })
    .isString()
    .withMessage('fallbackProvider must be a string')
    .bail()
    .isLength({ max: 64 })
    .withMessage('fallbackProvider must be at most 64 characters'),
  body('fallbackModel')
    .optional({ nullable: true })
    .isString()
    .withMessage('fallbackModel must be a string')
    .bail()
    .isLength({ max: 120 })
    .withMessage('fallbackModel must be at most 120 characters'),
  body('humanSupportEmail')
    .optional({ nullable: true })
    .isString()
    .withMessage('humanSupportEmail must be a string')
    .bail()
    .isLength({ max: 255 })
    .withMessage('humanSupportEmail must be at most 255 characters'),
  body('humanSupportUrl')
    .optional({ nullable: true })
    .isString()
    .withMessage('humanSupportUrl must be a string')
    .bail()
    .isLength({ max: 500 })
    .withMessage('humanSupportUrl must be at most 500 characters'),
];

const feedbackValidators = [
  body('helpful').isBoolean().withMessage('helpful must be a boolean'),
  body('messageId')
    .optional({ nullable: true })
    .isString()
    .withMessage('messageId must be a string')
    .bail()
    .isLength({ max: 64 })
    .withMessage('messageId must be at most 64 characters'),
];

router.post('/chat', chatLimiter, chatValidators, validate, samChatController.chat);

// The configuration a signed-in account may read: whether the assistant is
// switched on, which model answers and which mark it wears. Reading it is
// not an administrative act, so it is not permission-gated.
router.get('/config', samChatController.getConfig);

// Writing it is: the operator decides which provider the installation talks
// to and where a person can be reached.
router.put('/config', requirePermission('superAdmin', 'edit'), configValidators, validate, samChatController.updateConfig);

router.get(
  '/models',
  query('provider')
    .isString()
    .withMessage('provider must be a string')
    .bail()
    .isIn(samChatController.knownProviders())
    .withMessage('provider is not a known provider'),
  validate,
  samChatController.listModels
);

router.post(
  '/profile-image',
  requirePermission('superAdmin', 'edit'),
  upload.single('file'),
  validate,
  samChatController.uploadProfileImage
);

router.get('/profile-image', samChatController.getProfileImage);

router.delete('/profile-image', requirePermission('superAdmin', 'edit'), samChatController.deleteProfileImage);

router.post('/feedback', feedbackValidators, validate, samChatController.recordFeedback);

export default router;
