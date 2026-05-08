export interface StackTemplate {
  id:          string;
  name:        string;
  icon:        string;
  tagline:     string;
  category:    string;
  composeYaml: string;
  defaultPort: string;
  scheme:      "http" | "https";
}

export const STACK_TEMPLATES: StackTemplate[] = [
  {
    id:          "jellyfin",
    name:        "Jellyfin",
    icon:        "https://jellyfin.org/images/favicon.png",
    tagline:     "Free media server for your collection",
    category:    "Media",
    defaultPort: "8096",
    scheme:      "http",
    composeYaml: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    container_name: jellyfin
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - ./data/config:/config
      - ./data/cache:/cache
      - /path/to/media:/media  # CHANGE ME
    environment:
      - JELLYFIN_PublishedServerUrl=http://localhost:8096
`,
  },
  {
    id:          "vaultwarden",
    name:        "Vaultwarden",
    icon:        "https://raw.githubusercontent.com/dani-garcia/vaultwarden/main/resources/vaultwarden-icon.svg",
    tagline:     "Lightweight Bitwarden-compatible password manager",
    category:    "Security",
    defaultPort: "8080",
    scheme:      "http",
    composeYaml: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    container_name: vaultwarden
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - ./data:/data
    environment:
      - ADMIN_TOKEN=change-me-to-a-secure-token  # CHANGE ME
      - SIGNUPS_ALLOWED=false
`,
  },
  {
    id:          "nextcloud",
    name:        "Nextcloud",
    icon:        "https://nextcloud.com/wp-content/themes/next/assets/img/common/favicon.png",
    tagline:     "Self-hosted cloud storage and collaboration",
    category:    "Productivity",
    defaultPort: "8081",
    scheme:      "http",
    composeYaml: `services:
  nextcloud:
    image: nextcloud:latest
    container_name: nextcloud
    restart: unless-stopped
    ports:
      - "8081:80"
    volumes:
      - ./data:/var/www/html
    environment:
      - MYSQL_HOST=db
      - MYSQL_DATABASE=nextcloud
      - MYSQL_USER=nextcloud
      - MYSQL_PASSWORD=change-me  # CHANGE ME
      - NEXTCLOUD_ADMIN_USER=admin
      - NEXTCLOUD_ADMIN_PASSWORD=change-me  # CHANGE ME
    depends_on:
      - db

  db:
    image: mariadb:lts
    container_name: nextcloud-db
    restart: unless-stopped
    volumes:
      - ./data/db:/var/lib/mysql
    environment:
      - MYSQL_ROOT_PASSWORD=change-me  # CHANGE ME
      - MYSQL_DATABASE=nextcloud
      - MYSQL_USER=nextcloud
      - MYSQL_PASSWORD=change-me  # CHANGE ME
`,
  },
  {
    id:          "portainer",
    name:        "Portainer",
    icon:        "https://www.portainer.io/hubfs/portainer-logo-new.svg",
    tagline:     "Docker management GUI",
    category:    "Admin",
    defaultPort: "9000",
    scheme:      "http",
    composeYaml: `services:
  portainer:
    image: portainer/portainer-ce:latest
    container_name: portainer
    restart: unless-stopped
    ports:
      - "9000:9000"
      - "8000:8000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
`,
  },
  {
    id:          "gitea",
    name:        "Gitea",
    icon:        "https://about.gitea.com/favicon.ico",
    tagline:     "Lightweight self-hosted Git service",
    category:    "Dev",
    defaultPort: "3001",
    scheme:      "http",
    composeYaml: `services:
  gitea:
    image: gitea/gitea:latest
    container_name: gitea
    restart: unless-stopped
    ports:
      - "3001:3000"
      - "222:22"
    volumes:
      - ./data:/data
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - GITEA__database__DB_TYPE=sqlite3
      - GITEA__database__PATH=/data/gitea/gitea.db
`,
  },
  {
    id:          "homeassistant",
    name:        "Home Assistant",
    icon:        "https://www.home-assistant.io/images/favicon-192x192-full.png",
    tagline:     "Open source home automation platform",
    category:    "IoT",
    defaultPort: "8123",
    scheme:      "http",
    composeYaml: `services:
  homeassistant:
    image: homeassistant/home-assistant:latest
    container_name: homeassistant
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data/config:/config
      - /etc/localtime:/etc/localtime:ro
    privileged: true
`,
  },
  {
    id:          "uptimekuma",
    name:        "Uptime Kuma",
    icon:        "https://uptime.kuma.pet/img/icon.svg",
    tagline:     "Self-hosted monitoring dashboard",
    category:    "Monitoring",
    defaultPort: "3002",
    scheme:      "http",
    composeYaml: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:latest
    container_name: uptime-kuma
    restart: unless-stopped
    ports:
      - "3002:3001"
    volumes:
      - ./data:/app/data
`,
  },
  {
    id:          "pihole",
    name:        "Pi-hole",
    icon:        "https://pi-hole.net/wp-content/uploads/2016/12/Vortex-R.png",
    tagline:     "Network-wide ad blocking DNS server",
    category:    "Network",
    defaultPort: "8082",
    scheme:      "http",
    composeYaml: `services:
  pihole:
    image: pihole/pihole:latest
    container_name: pihole
    restart: unless-stopped
    ports:
      - "53:53/tcp"
      - "53:53/udp"
      - "8082:80"
    volumes:
      - ./data/pihole:/etc/pihole
      - ./data/dnsmasq:/etc/dnsmasq.d
    environment:
      - TZ=America/New_York  # CHANGE ME
      - WEBPASSWORD=change-me  # CHANGE ME
`,
  },
];
