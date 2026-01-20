/**
 * Onboarding Service
 *
 * Tenant onboarding, eğitim ve rehberlik sistemi.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  OnboardingProgress,
  OnboardingStatus,
  OnboardingStep,
  TrainingSession,
} from '../entities/support.entity';

// ============================================================================
// Onboarding Steps Configuration
// ============================================================================

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Welcome Email',
    description: 'Receive welcome email with getting started guide',
    order: 1,
    isRequired: true,
    estimatedMinutes: 5,
  },
  {
    id: 'profile_setup',
    title: 'Complete Profile',
    description: 'Set up your organization profile and preferences',
    order: 2,
    isRequired: true,
    estimatedMinutes: 10,
  },
  {
    id: 'team_invite',
    title: 'Invite Team Members',
    description: 'Add your team members and assign roles',
    order: 3,
    isRequired: false,
    estimatedMinutes: 15,
  },
  {
    id: 'farm_setup',
    title: 'Set Up First Farm',
    description: 'Configure your first farm with sites and pools',
    order: 4,
    isRequired: true,
    estimatedMinutes: 20,
    videoUrl: '/tutorials/farm-setup',
  },
  {
    id: 'sensor_config',
    title: 'Configure Sensors',
    description: 'Add and configure monitoring sensors',
    order: 5,
    isRequired: false,
    estimatedMinutes: 30,
    videoUrl: '/tutorials/sensor-setup',
  },
  {
    id: 'alert_rules',
    title: 'Set Up Alert Rules',
    description: 'Configure automated alerts and notifications',
    order: 6,
    isRequired: false,
    estimatedMinutes: 15,
    videoUrl: '/tutorials/alerts',
  },
  {
    id: 'dashboard_tour',
    title: 'Dashboard Tour',
    description: 'Take a guided tour of the main dashboard',
    order: 7,
    isRequired: false,
    estimatedMinutes: 10,
    videoUrl: '/tutorials/dashboard-tour',
  },
  {
    id: 'reports_intro',
    title: 'Reports Introduction',
    description: 'Learn how to generate and export reports',
    order: 8,
    isRequired: false,
    estimatedMinutes: 10,
    videoUrl: '/tutorials/reports',
  },
];

// ============================================================================
// Training Resources
// ============================================================================

export interface TrainingResource {
  id: string;
  title: string;
  description: string;
  type: 'video' | 'document' | 'webinar' | 'interactive';
  url: string;
  duration: number;
  category: string;
  order: number;
}

const TRAINING_RESOURCES: TrainingResource[] = [
  {
    id: 'getting-started',
    title: 'Getting Started Guide',
    description: 'Complete guide to setting up your aquaculture management system',
    type: 'document',
    url: '/docs/getting-started',
    duration: 30,
    category: 'basics',
    order: 1,
  },
  {
    id: 'farm-management',
    title: 'Farm Management Tutorial',
    description: 'Learn how to manage farms, sites, and pools',
    type: 'video',
    url: '/videos/farm-management',
    duration: 15,
    category: 'core',
    order: 2,
  },
  {
    id: 'sensor-integration',
    title: 'Sensor Integration Guide',
    description: 'How to integrate and configure IoT sensors',
    type: 'video',
    url: '/videos/sensor-integration',
    duration: 20,
    category: 'advanced',
    order: 3,
  },
  {
    id: 'alert-system',
    title: 'Alert System Configuration',
    description: 'Configure automated alerts and notifications',
    type: 'video',
    url: '/videos/alert-system',
    duration: 12,
    category: 'core',
    order: 4,
  },
  {
    id: 'reporting',
    title: 'Reporting & Analytics',
    description: 'Generate insights with reports and analytics',
    type: 'video',
    url: '/videos/reporting',
    duration: 18,
    category: 'core',
    order: 5,
  },
  {
    id: 'mobile-app',
    title: 'Mobile App Usage',
    description: 'Use the mobile app for on-the-go management',
    type: 'video',
    url: '/videos/mobile-app',
    duration: 10,
    category: 'advanced',
    order: 6,
  },
  {
    id: 'api-integration',
    title: 'API Integration Guide',
    description: 'Integrate with external systems using our API',
    type: 'document',
    url: '/docs/api-integration',
    duration: 45,
    category: 'developer',
    order: 7,
  },
  {
    id: 'best-practices',
    title: 'Best Practices Webinar',
    description: 'Monthly webinar on aquaculture management best practices',
    type: 'webinar',
    url: '/webinars/best-practices',
    duration: 60,
    category: 'advanced',
    order: 8,
  },
];

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectRepository(OnboardingProgress)
    private readonly progressRepository: Repository<OnboardingProgress>,
  ) {}

  // ============================================================================
  // Onboarding Progress
  // ============================================================================

  /**
   * Initialize onboarding for tenant
   */
  async initializeOnboarding(
    tenantId: string,
    tenantName: string,
  ): Promise<OnboardingProgress> {
    this.logger.log(`Initializing onboarding for tenant: ${tenantId}`);

    // Check if already exists
    let progress = await this.progressRepository.findOne({
      where: { tenantId },
    });

    if (progress) {
      return progress;
    }

    const firstStep = ONBOARDING_STEPS[0];
    progress = this.progressRepository.create({
      tenantId,
      tenantName,
      status: 'not_started' as OnboardingStatus,
      completionPercent: 0,
      completedSteps: [],
      currentStep: firstStep?.id ?? 'account_setup',
    });

    return this.progressRepository.save(progress);
  }

  /**
   * Get onboarding progress
   */
  async getProgress(tenantId: string): Promise<OnboardingProgress> {
    const progress = await this.progressRepository.findOne({
      where: { tenantId },
    });

    if (!progress) {
      throw new NotFoundException(`Onboarding not found for tenant: ${tenantId}`);
    }

    return progress;
  }

  /**
   * Get all onboarding progress
   */
  async getAllProgress(options: {
    page?: number;
    limit?: number;
    status?: OnboardingStatus;
  }): Promise<{
    data: OnboardingProgress[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, status } = options;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const [data, total] = await this.progressRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  /**
   * Get onboarding steps
   */
  getOnboardingSteps(): OnboardingStep[] {
    return ONBOARDING_STEPS;
  }

  /**
   * Complete onboarding step
   */
  async completeStep(tenantId: string, stepId: string): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);

    // Check if step exists
    const step = ONBOARDING_STEPS.find(s => s.id === stepId);
    if (!step) {
      throw new NotFoundException(`Step not found: ${stepId}`);
    }

    // Add to completed if not already
    if (!progress.completedSteps.includes(stepId)) {
      progress.completedSteps.push(stepId);
    }

    // Update status and completion
    if (progress.status === 'not_started') {
      progress.status = 'in_progress';
      progress.startedAt = new Date();
    }

    // Calculate completion percentage
    const requiredSteps = ONBOARDING_STEPS.filter(s => s.isRequired);
    const completedRequired = requiredSteps.filter(s =>
      progress.completedSteps.includes(s.id)
    );
    progress.completionPercent = Math.round(
      (completedRequired.length / requiredSteps.length) * 100
    );

    // Determine next step
    const currentIndex = ONBOARDING_STEPS.findIndex(s => s.id === stepId);
    if (currentIndex < ONBOARDING_STEPS.length - 1) {
      const nextStep = ONBOARDING_STEPS[currentIndex + 1];
      if (nextStep) {
        progress.currentStep = nextStep.id;
      }
    }

    // Check if all required steps completed
    if (progress.completionPercent >= 100) {
      progress.status = 'completed';
      progress.completedAt = new Date();
    }

    return this.progressRepository.save(progress);
  }

  /**
   * Skip onboarding step
   */
  async skipStep(tenantId: string, stepId: string): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);

    const step = ONBOARDING_STEPS.find(s => s.id === stepId);
    if (!step) {
      throw new NotFoundException(`Step not found: ${stepId}`);
    }

    if (step.isRequired) {
      throw new Error(`Cannot skip required step: ${stepId}`);
    }

    // Move to next step
    const currentIndex = ONBOARDING_STEPS.findIndex(s => s.id === stepId);
    if (currentIndex < ONBOARDING_STEPS.length - 1) {
      const nextStep = ONBOARDING_STEPS[currentIndex + 1];
      if (nextStep) {
        progress.currentStep = nextStep.id;
      }
    }

    return this.progressRepository.save(progress);
  }

  /**
   * Skip entire onboarding
   */
  async skipOnboarding(tenantId: string): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);
    progress.status = 'skipped';
    return this.progressRepository.save(progress);
  }

  // ============================================================================
  // Welcome Email
  // ============================================================================

  /**
   * Send welcome email
   */
  async sendWelcomeEmail(
    tenantId: string,
    recipientEmail: string,
    recipientName: string,
  ): Promise<void> {
    this.logger.log(`Sending welcome email to ${recipientEmail} for tenant ${tenantId}`);

    const progress = await this.getProgress(tenantId);

    // TODO: Integrate with email service
    // await this.emailService.send({
    //   to: recipientEmail,
    //   template: 'welcome',
    //   data: {
    //     name: recipientName,
    //     loginUrl: 'https://app.example.com/login',
    //     gettingStartedUrl: 'https://docs.example.com/getting-started',
    //   },
    // });

    progress.welcomeEmailSent = true;
    progress.welcomeEmailSentAt = new Date();
    await this.progressRepository.save(progress);

    // Complete welcome step
    await this.completeStep(tenantId, 'welcome');
  }

  // ============================================================================
  // Training
  // ============================================================================

  /**
   * Get training resources
   */
  getTrainingResources(category?: string): TrainingResource[] {
    if (category) {
      return TRAINING_RESOURCES.filter(r => r.category === category);
    }
    return TRAINING_RESOURCES;
  }

  /**
   * Record tutorial view
   */
  async recordTutorialView(tenantId: string, tutorialId: string): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);

    if (!progress.viewedTutorials) {
      progress.viewedTutorials = [];
    }

    if (!progress.viewedTutorials.includes(tutorialId)) {
      progress.viewedTutorials.push(tutorialId);
    }

    return this.progressRepository.save(progress);
  }

  /**
   * Record getting started view
   */
  async recordGettingStartedView(tenantId: string): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);
    progress.gettingStartedViewed = true;
    return this.progressRepository.save(progress);
  }

  // ============================================================================
  // Training Sessions
  // ============================================================================

  /**
   * Schedule training session
   */
  async scheduleTrainingSession(
    tenantId: string,
    session: Omit<TrainingSession, 'id' | 'status'>,
  ): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);

    if (!progress.scheduledTrainings) {
      progress.scheduledTrainings = [];
    }

    const newSession: TrainingSession = {
      id: `training_${Date.now()}`,
      ...session,
      status: 'scheduled',
    };

    progress.scheduledTrainings.push(newSession);

    return this.progressRepository.save(progress);
  }

  /**
   * Update training session status
   */
  async updateTrainingSession(
    tenantId: string,
    sessionId: string,
    status: 'completed' | 'cancelled',
    notes?: string,
  ): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);

    const session = progress.scheduledTrainings?.find(s => s.id === sessionId);
    if (!session) {
      throw new NotFoundException(`Training session not found: ${sessionId}`);
    }

    session.status = status;
    if (notes) session.notes = notes;

    return this.progressRepository.save(progress);
  }

  /**
   * Assign onboarding guide
   */
  async assignGuide(
    tenantId: string,
    guideId: string,
    guideName: string,
  ): Promise<OnboardingProgress> {
    const progress = await this.getProgress(tenantId);
    progress.assignedGuide = guideId;
    progress.assignedGuideName = guideName;
    return this.progressRepository.save(progress);
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get onboarding statistics
   */
  async getOnboardingStats(): Promise<{
    total: number;
    notStarted: number;
    inProgress: number;
    completed: number;
    skipped: number;
    avgCompletionPercent: number;
    avgCompletionDays: number;
    completionByStep: Record<string, number>;
  }> {
    const all = await this.progressRepository.find();

    const completed = all.filter(p => p.status === 'completed');
    const avgCompletion = all.length > 0
      ? all.reduce((sum, p) => sum + p.completionPercent, 0) / all.length
      : 0;

    // Calculate average completion time
    let avgDays = 0;
    if (completed.length > 0) {
      const totalDays = completed.reduce((sum, p) => {
        if (p.completedAt && p.startedAt) {
          return sum + (p.completedAt.getTime() - p.startedAt.getTime()) / (1000 * 60 * 60 * 24);
        }
        return sum;
      }, 0);
      avgDays = Math.round(totalDays / completed.length);
    }

    // Calculate completion by step
    const completionByStep: Record<string, number> = {};
    for (const step of ONBOARDING_STEPS) {
      completionByStep[step.id] = all.filter(p =>
        p.completedSteps?.includes(step.id)
      ).length;
    }

    return {
      total: all.length,
      notStarted: all.filter(p => p.status === 'not_started').length,
      inProgress: all.filter(p => p.status === 'in_progress').length,
      completed: completed.length,
      skipped: all.filter(p => p.status === 'skipped').length,
      avgCompletionPercent: Math.round(avgCompletion),
      avgCompletionDays: avgDays,
      completionByStep,
    };
  }

  /**
   * Get tenants needing attention (stuck in onboarding)
   */
  async getTenantsNeedingAttention(): Promise<OnboardingProgress[]> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const all = await this.progressRepository.find({
      where: { status: 'in_progress' as OnboardingStatus },
    });

    // Return tenants who haven't made progress in 30 days
    return all.filter(p => {
      const lastUpdate = p.updatedAt || p.createdAt;
      return lastUpdate < thirtyDaysAgo;
    });
  }
}
