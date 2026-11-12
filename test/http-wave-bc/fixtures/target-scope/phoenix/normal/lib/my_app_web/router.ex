defmodule MyAppWeb.UserPlug do
  def init(action), do: action

  def call(conn, action) do
    Plug.Conn.send_resp(conn, 200, Atom.to_string(action))
  end
end

defmodule MyAppWeb.Router do
  use Phoenix.Router, helpers: false

  scope "/api" do
    get "/users/:id", MyAppWeb.UserPlug, :show
    post "/users", MyAppWeb.UserPlug, :create
  end
end
