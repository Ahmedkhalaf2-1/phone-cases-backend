import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { StringValue } from 'ms';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthResponseDto } from './dto/auth-response.dto';
import type { JwtPayload } from './types/jwt-payload.type';

const REFRESH_TOKEN_BYTES = 48;
const BCRYPT_SALT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async login(email: string, password: string, ip: string | undefined): Promise<AuthResponseDto> {
    const staff = await this.prisma.staffUser.findUnique({ where: { email } });

    // Always hash even when the account does not exist, so login timing
    // does not reveal whether an email address is registered.
    const passwordHash =
      staff?.passwordHash ??
      (await bcrypt.hash(randomBytes(16).toString('hex'), BCRYPT_SALT_ROUNDS));
    const passwordMatches = await bcrypt.compare(password, passwordHash);

    if (!staff || !staff.isActive || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const { accessToken, refreshToken, expiresIn } = await this.issueTokenPair(
      this.prisma,
      staff.id,
      staff.email,
      staff.role,
      ip,
    );

    await this.auditLogService.record({
      staffUserId: staff.id,
      action: 'auth.login',
      entityType: 'StaffUser',
      entityId: staff.id,
      ipAddress: ip ?? null,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn,
      staff: { id: staff.id, email: staff.email, fullName: staff.fullName, role: staff.role },
    };
  }

  /**
   * Rotation is atomic: revoking the presented token and minting its
   * successor happen in one transaction, gated by a conditional UPDATE
   * (`WHERE revokedAt IS NULL`) rather than a separate read-then-write.
   * Without this, two concurrent requests presenting the same
   * not-yet-revoked token could both pass the initial read check and
   * both mint a valid successor session before either revocation
   * committed. The guard is what actually prevents that: only one
   * transaction's UPDATE can ever match a token still unrevoked, so a
   * second concurrent attempt is guaranteed to see it already revoked and
   * fail with the same "invalid or expired" response a genuine reuse
   * attempt would get - it cannot distinguish "someone else refreshed
   * first" from token theft, which is the correct, conservative behavior
   * either way. See docs/DECISIONS.md.
   */
  async refresh(rawRefreshToken: string, ip: string | undefined): Promise<AuthResponseDto> {
    const tokenHash = this.hashToken(rawRefreshToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { staffUser: true },
    });

    if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }
    if (!existing.staffUser.isActive) {
      throw new UnauthorizedException('Staff account is inactive');
    }
    const { staffUser } = existing;

    const tokenPair = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new UnauthorizedException('Refresh token is invalid or expired');
      }

      const issued = await this.issueTokenPair(
        tx,
        staffUser.id,
        staffUser.email,
        staffUser.role,
        ip,
      );
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { replacedByTokenId: issued.refreshTokenId },
      });
      return issued;
    });

    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      staff: {
        id: staffUser.id,
        email: staffUser.email,
        fullName: staffUser.fullName,
        role: staffUser.role,
      },
    };
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokenPair(
    client: PrismaService | Prisma.TransactionClient,
    staffId: string,
    email: string,
    role: JwtPayload['role'],
    ip: string | undefined,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: string;
    refreshTokenId: string;
  }> {
    const payload: JwtPayload = { sub: staffId, email, role };
    const expiresIn = this.configService.getOrThrow<string>('JWT_ACCESS_EXPIRES_IN');
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: expiresIn as StringValue,
    });

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshExpiresIn = this.configService.getOrThrow<string>('JWT_REFRESH_EXPIRES_IN');
    const expiresAt = new Date(Date.now() + this.parseDurationMs(refreshExpiresIn));

    const created = await client.refreshToken.create({
      data: {
        staffUserId: staffId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
        createdByIp: ip ?? null,
      },
    });

    return { accessToken, refreshToken, expiresIn, refreshTokenId: created.id };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration.trim());
    if (!match) {
      throw new Error(`Unsupported duration format: "${duration}". Use e.g. "15m", "7d".`);
    }
    const value = Number(match[1]);
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return value * unitMs[match[2]];
  }
}
