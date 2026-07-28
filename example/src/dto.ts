export type ProjectStatus = 'active' | 'paused' | 'completed';

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  ownerEmail: string;
  archived: boolean;
  createdAt: string;
}

export interface CreateProjectDto {
  name: string;
  ownerEmail: string;
  status?: ProjectStatus;
}

export type UpdateProjectDto = Partial<Pick<Project, 'name' | 'status' | 'archived'>>;

export interface ListProjectsQuery {
  status?: ProjectStatus;
  /** Page size, 1–100. Renamed from `perPage` in v2. */
  limit?: number;
  cursor?: string;
}

export interface ListProjectsResponse {
  data: Project[];
  nextCursor: string | null;
}
