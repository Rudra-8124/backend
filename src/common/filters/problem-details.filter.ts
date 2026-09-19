import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * RFC 7807 Problem Details error format.
 * Maps all exceptions to a consistent JSON structure.
 */
interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: unknown[];
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status: number;
    let title: string;
    let detail: string | undefined;
    let errors: unknown[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        title = response;
      } else if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        title = (r['title'] as string) || (r['error'] as string) || exception.message;
        detail =
          (r['detail'] as string) || (typeof r['message'] === 'string' ? r['message'] : undefined);
        if (Array.isArray(r['message'])) {
          errors = r['message'] as unknown[];
          detail = 'Validation failed';
        }
      } else {
        title = exception.message;
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      title = 'Internal Server Error';
      // Never leak internal error details to clients
      this.logger.error(exception, 'Unhandled exception');
    }

    const problem: ProblemDetail = {
      type: `https://httpstatuses.io/${status}`,
      title,
      status,
      ...(detail ? { detail } : {}),
      ...(errors ? { errors } : {}),
      instance: request.url,
    };

    void reply.status(status).header('content-type', 'application/problem+json').send(problem);
  }
}
