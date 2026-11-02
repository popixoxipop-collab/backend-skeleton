defmodule MyAppWeb.TokenPlug do
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    case get_req_header(conn, "x-token") do
      ["ok"] -> conn
      _ -> conn |> send_resp(401, "unauthorized") |> halt()
    end
  end
end

defmodule MyAppWeb.UserPlug do
  def init(opts), do: opts
  def call(conn, _opts), do: Plug.Conn.send_resp(conn, 200, "users")
end

defmodule MyAppWeb.Router do
  use Phoenix.Router, helpers: false

  pipeline :authenticated do
    plug MyAppWeb.TokenPlug
  end

  scope "/private" do
    pipe_through :authenticated
    get "/users", MyAppWeb.UserPlug, []
  end
end
