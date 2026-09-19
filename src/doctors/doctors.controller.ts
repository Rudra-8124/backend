import { Controller, Get, Patch, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/rate-limit/rate-limit.guard';
import { DoctorsService, DoctorProfileResponse } from './doctors.service';
import { UpdateDoctorProfileDto } from './dto/update-doctor-profile.dto';

@ApiTags('doctors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Get(':id')
  @RateLimit('relaxed')
  @ApiOperation({ summary: 'Get doctor profile by ID (cached with Redis)' })
  @ApiResponse({ status: 200, description: 'Doctor profile' })
  @ApiResponse({ status: 404, description: 'Doctor not found' })
  async getDoctor(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: DoctorProfileResponse; cached: boolean }> {
    return this.doctorsService.getDoctorProfile(id);
  }

  @Patch('me')
  @Roles('doctor')
  @RateLimit('standard')
  @ApiOperation({ summary: 'Update doctor profile (invalidates search and profile caches)' })
  @ApiResponse({ status: 200, description: 'Updated doctor profile' })
  async updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateDoctorProfileDto,
  ): Promise<DoctorProfileResponse> {
    return this.doctorsService.updateDoctorProfile(user.userId, dto);
  }
}
