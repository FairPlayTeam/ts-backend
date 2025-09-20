export interface ApiResponse<T = any> {
  message?: string;
  data?: T;
  error?: string;
}

export interface UserResponse {
  id: string;
  email: string;
  username: string;
  role: string;
}

export interface LoginRequest {
  emailOrUsername: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
}
