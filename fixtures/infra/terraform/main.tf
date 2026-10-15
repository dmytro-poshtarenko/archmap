variable "orders_url" {
  default = "http://orders:3000"
}

locals {
  api = "${var.orders_url}/api"
}

resource "kubernetes_deployment" "gateway" {
  metadata {
    name = "gateway"
  }
  spec {
    template {
      metadata {
        labels = {
          app = "gateway"
        }
      }
      spec {
        container {
          name  = "gateway"
          image = "example/gateway"
          env {
            name  = "ORDERS_URL"
            value = local.api
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "gateway" {
  metadata {
    name = "gateway-svc"
  }
  spec {
    selector = {
      app = "gateway"
    }
    port {
      port = 80
    }
  }
}

resource "kubernetes_ingress_v1" "edge" {
  metadata {
    name = "edge"
  }
  spec {
    rule {
      http {
        path {
          path      = "/orders"
          path_type = "Prefix"
          backend {
            service {
              name = "gateway-svc"
            }
          }
        }
      }
    }
  }
}

resource "docker_container" "orders" {
  name  = "orders"
  image = "example/orders"
  env   = ["PORT=3000", "DB=mongodb://mongo:27017/orders"]
}
