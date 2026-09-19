import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Doctor } from './entities/doctor.entity';
import { CacheService } from '../common/cache/cache.service';
import { UpdateDoctorProfileDto } from './dto/update-doctor-profile.dto';

export interface DoctorProfileResponse {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  city: string | null;
  phone: string | null;
  bio: string | null;
  licenseNumber: string;
  specializations: string[];
  languages: string[];
  experienceYears: number;
  feeCents: number;
  ratingAvg: number;
  ratingCount: number;
  isVerified: boolean;
}

@Injectable()
export class DoctorsService {
  private readonly logger = new Logger(DoctorsService.name);

  constructor(
    @InjectRepository(Doctor)
    private readonly doctorRepository: Repository<Doctor>,
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Get public doctor profile by Doctor ID, with Redis cache-aside.
   */
  async getDoctorProfile(
    doctorId: string,
  ): Promise<{ data: DoctorProfileResponse; cached: boolean }> {
    return this.cacheService.getOrSet<DoctorProfileResponse>({
      namespace: 'doctor:profile',
      identifier: doctorId,
      ttlSeconds: 900, // 15 min
      jitterSeconds: 60,
      fetcher: async () => {
        const rows = await this.dataSource.query(
          `
          SELECT
            d.id,
            d.user_id AS "userId",
            p.first_name AS "firstName",
            p.last_name AS "lastName",
            (p.first_name || ' ' || p.last_name) AS "fullName",
            p.city,
            p.phone,
            d.bio,
            d.license_number AS "licenseNumber",
            d.specializations,
            d.languages,
            d.experience_years AS "experienceYears",
            d.fee_cents AS "feeCents",
            d.rating_avg AS "ratingAvg",
            d.rating_count AS "ratingCount",
            d.is_verified AS "isVerified"
          FROM doctors d
          JOIN profiles p ON p.user_id = d.user_id
          JOIN users u ON u.id = d.user_id
          WHERE d.id = $1 AND d.is_verified = true AND u.is_active = true
          LIMIT 1
          `,
          [doctorId],
        );

        if (rows.length === 0) {
          throw new NotFoundException(`Doctor with ID ${doctorId} not found or not verified`);
        }

        return rows[0];
      },
    });
  }

  /**
   * Update doctor profile for logged-in doctor.
   * Atomically invalidates doctor:profile and search:doctors namespaces.
   */
  async updateDoctorProfile(
    userId: string,
    dto: UpdateDoctorProfileDto,
  ): Promise<DoctorProfileResponse> {
    const doctor = await this.doctorRepository.findOne({ where: { userId } });
    if (!doctor) {
      throw new NotFoundException('Doctor profile not found for current user');
    }

    if (dto.bio !== undefined) doctor.bio = dto.bio;
    if (dto.specializations !== undefined) doctor.specializations = dto.specializations;
    if (dto.languages !== undefined) doctor.languages = dto.languages;
    if (dto.fee_cents !== undefined) doctor.feeCents = dto.fee_cents;
    if (dto.experience_years !== undefined) doctor.experienceYears = dto.experience_years;

    await this.doctorRepository.save(doctor);

    // Invalidate caches via per-namespace version counter increment
    await Promise.all([
      this.cacheService.invalidateNamespace('doctor:profile'),
      this.cacheService.invalidateNamespace('search:doctors'),
    ]);

    const rows = await this.dataSource.query(
      `
      SELECT
        d.id,
        d.user_id AS "userId",
        p.first_name AS "firstName",
        p.last_name AS "lastName",
        (p.first_name || ' ' || p.last_name) AS "fullName",
        p.city,
        p.phone,
        d.bio,
        d.license_number AS "licenseNumber",
        d.specializations,
        d.languages,
        d.experience_years AS "experienceYears",
        d.fee_cents AS "feeCents",
        d.rating_avg AS "ratingAvg",
        d.rating_count AS "ratingCount",
        d.is_verified AS "isVerified"
      FROM doctors d
      JOIN profiles p ON p.user_id = d.user_id
      JOIN users u ON u.id = d.user_id
      WHERE d.id = $1
      LIMIT 1
      `,
      [doctor.id],
    );

    return rows[0];
  }
}
