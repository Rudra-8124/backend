import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { Profile } from './entities/profile.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Profile) private readonly profileRepo: Repository<Profile>,
  ) {}

  async findById(id: string) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    const profile = await this.profileRepo.findOne({ where: { userId: id } });
    return { ...user, profile, passwordHash: undefined, mfaSecret: undefined };
  }

  async updateProfile(
    userId: string,
    updates: Partial<{ firstName: string; lastName: string; phone: string; city: string }>,
  ) {
    const profile = await this.profileRepo.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('Profile not found');
    Object.assign(profile, updates);
    await this.profileRepo.save(profile);
    return this.findById(userId);
  }

  async findAll(cursor?: string, limit = 20) {
    const qb = this.userRepo
      .createQueryBuilder('u')
      .select(['u.id', 'u.email', 'u.role', 'u.isActive', 'u.createdAt'])
      .orderBy('u.createdAt', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .take(limit + 1);

    if (cursor) {
      qb.where('u.id > :cursor', { cursor });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return { users: items, nextCursor };
  }
}
