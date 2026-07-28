import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateProjectDto,
  ListProjectsQuery,
  ListProjectsResponse,
  Project,
  UpdateProjectDto,
} from './dto.js';

// ponytail: in-memory store — this is a fixture for docdrift, not a real API.
@Injectable()
export class ProjectsService {
  private readonly projects = new Map<string, Project>();
  private seq = 0;

  create(dto: CreateProjectDto): Project {
    const project: Project = {
      id: `prj_${++this.seq}`,
      name: dto.name,
      status: dto.status ?? 'active',
      ownerEmail: dto.ownerEmail,
      archived: false,
      createdAt: new Date().toISOString(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  list(query: ListProjectsQuery): ListProjectsResponse {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const all = [...this.projects.values()].filter(
      (p) => !query.status || p.status === query.status,
    );
    const start = query.cursor ? all.findIndex((p) => p.id === query.cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    const last = page.at(-1);
    return {
      data: page,
      nextCursor: last && start + limit < all.length ? last.id : null,
    };
  }

  get(id: string): Project {
    const project = this.projects.get(id);
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  update(id: string, dto: UpdateProjectDto): Project {
    const updated = { ...this.get(id), ...dto };
    this.projects.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    this.get(id);
    this.projects.delete(id);
  }
}
