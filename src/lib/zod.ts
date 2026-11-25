import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds .openapi() to Zod schemas so the same schemas validate requests and document the API.
extendZodWithOpenApi(z);

export { z };
