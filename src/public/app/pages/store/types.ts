export interface AppRepo {
  id:        number;
  name:      string;
  url:       string;
  enabled:   boolean;
  createdAt: number;
}

export interface StoreApp {
  id:               string;
  repoId:           number;
  appName:          string;
  title:            string;
  icon:             string;
  tagline:          string;
  description:      string;
  category:         string;
  developer:        string;
  author:           string;
  thumbnail:        string;
  screenshots:      string[];
  beforeInstallTip: string;
  portMap:          string;
  mainService:      string;
  architectures:    string[];
  composeUrl:       string;
  version:          string;
  updatedAt:        string;
  releaseNotes:     string;
  website:          string;
  repo:             string;
  support:          string;
  docs:             string;
}
