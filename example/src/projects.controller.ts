import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { ProjectsService } from './projects.service.js';
import type {
  CreateProjectDto,
  ListProjectsQuery,
  ListProjectsResponse,
  Project,
  UpdateProjectDto,
} from './dto.js';

@Controller('v4/projects')
@UseGuards(BearerAuthGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateProjectDto): Project {
    return this.projects.create(dto);
  }

  @Get()
  list(@Query() query: ListProjectsQuery): ListProjectsResponse {
    return this.projects.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string): Project {
    return this.projects.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto): Project {
    return this.projects.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    this.projects.remove(id);
  }
}
