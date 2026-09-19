import { Controller, Get, Post, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';
import {
  AdminAnalyticsService,
  ConsultationsAnalyticsResponse,
  DoctorsAnalyticsResponse,
} from './admin-analytics.service';
import { ConsultationsAnalyticsDto, DoctorsAnalyticsDto } from './dto/analytics-query.dto';

@ApiTags('admin-analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AdminAnalyticsService) {}

  @Get('consultations')
  @RateLimit('standard')
  @ApiOperation({
    summary: 'Get consultations per day, cancellation/no-show rates, and revenue (Admin only)',
    description:
      'Queries materialized view for daily consultation counts, completion rate, cancellations, no-shows, and revenue. Enforces maximum 90-day window.',
  })
  @ApiResponse({ status: 200, description: 'Consultations analytics report' })
  @ApiResponse({ status: 400, description: 'Date range exceeds 90 days or invalid format' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async getConsultationsAnalytics(
    @Query() dto: ConsultationsAnalyticsDto,
  ): Promise<ConsultationsAnalyticsResponse> {
    return this.analyticsService.getConsultationsAnalytics(dto);
  }

  @Get('doctors')
  @RateLimit('standard')
  @ApiOperation({
    summary: 'Get doctor utilization, completion rate, and revenue (Admin only)',
    description:
      'Aggregates consultations and slot utilization per doctor with keyset cursor pagination. Enforces maximum 90-day window.',
  })
  @ApiResponse({ status: 200, description: 'Doctor utilization analytics report' })
  @ApiResponse({ status: 400, description: 'Date range exceeds 90 days or invalid format' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async getDoctorsAnalytics(@Query() dto: DoctorsAnalyticsDto): Promise<DoctorsAnalyticsResponse> {
    return this.analyticsService.getDoctorsAnalytics(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('strict')
  @ApiOperation({
    summary: 'Refresh daily consultation analytics materialized view concurrently (Admin only)',
  })
  @ApiResponse({ status: 200, description: 'Materialized view refreshed successfully' })
  async refreshView(): Promise<{ status: string; refreshedAt: string }> {
    return this.analyticsService.refreshMaterializedView();
  }
}
