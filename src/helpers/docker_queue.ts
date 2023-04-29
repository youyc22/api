import cron from "node-cron";
import { docker_queue } from "..";
import Docker from "dockerode";
import jwt from "jsonwebtoken";
import { JwtServerPayload } from "../routes/contest";
import { gql } from "graphql-request";
import { client } from "..";
import fs from "fs";

const base_directory = process.env.NODE_ENV === "production" ? '/data/thuai6/' : '/home/guoyun/thuai6';

export interface queue_element {
  room_id: string;
  team_id_1: string;
  team_id_2: string;
  map: number;
  mode: number;
  exposed: number;
}

const get_port = (room_id: string, exposed_ports: Array<string>) => {
  let result = -1;
  for (let i = 0; i < exposed_ports.length; ++i) {
    if (exposed_ports[i] === "") {
      exposed_ports[i] = room_id;
      result = i + 8888;
      break;
    }
  }
  if (result === -1) {
    for (let i = 0; i < exposed_ports.length; ++i) {
      // 查看basedirectory/room_id中是否存在finish.lock
      if (fs.existsSync(base_directory + "/playback/" + exposed_ports[i] + "/finish.lock")) {
        exposed_ports[i] = "";
      }
    }
    for (let i = 0; i < exposed_ports.length; ++i) {
      if (exposed_ports[i] === "") {
        if (result === -1) {
          exposed_ports[i] = room_id;
          result = i + 8888;
        }
      }
    }
  }
  return result;
}

const docker_cron = () => {
  const port_num = parseInt(process.env.MAX_CONTAINERS as string);
  const exposed_ports = new Array(port_num).fill("");

  cron.schedule(`*/${process.env.QUEUE_CHECK_TIME} * * * * *`, async () => {
    const max_container_num = parseInt(process.env.MAX_CONTAINERS as string);
    const docker =
      process.env.DOCKER === "remote"
        ? new Docker({
          host: process.env.DOCKER_URL,
          port: process.env.DOCKER_PORT,
        })
        : new Docker();

    try {
      const existing_containers = await docker.listContainers({
        all: true,
      });
      if (existing_containers.length > max_container_num) return;
      else {
        const available_num = Math.min(
          (max_container_num - existing_containers.length),
          docker_queue.length
        );
        if (available_num === 0) return;

        for (let i = 0; i < available_num; ++i) {
          const queue_front = docker_queue.shift() as queue_element;
          try {
            const query_if_compiled = await client.request(
              gql`
                query query_if_compiled($contest_id: uuid!, $team_id: [uuid!]) {
                  contest_team(where: {_and: {contest_id: {_eq: $contest_id}, team_id: {_in: $team_id}}}) {
                    status
                  }
                }
              `,
              {
                contest_id: process.env.GAME_ID,
                team_id: [queue_front.team_id_1, queue_front.team_id_2]
              }
            );
            let all_compiled = true;
            query_if_compiled.contest_team.forEach((element: { status: string }) => {
              if (element.status != "compiled") all_compiled = false;
            });
            if (!all_compiled) continue;
          } catch (err) {
            console.log(err);
            continue;
          }

          let containerRunning = false;
          const containerList = await docker.listContainers();
          containerList.forEach((containerInfo) => {
            if (
              containerInfo.Names.includes(
                `/THUAI6_runner_${queue_front?.room_id}`
              )
            ) {
              containerRunning = true;
            }
          });

          if (!containerRunning) {
            try {
              const serverToken = jwt.sign(
                {
                  room_id: queue_front.room_id,
                  team_ids: [queue_front.team_id_1, queue_front.team_id_2]
                } as JwtServerPayload,
                process.env.SECRET!,
                {
                  expiresIn: "30m",
                }
              );
              const url =
                process.env.NODE_ENV == "production"
                  ? "https://api.eesast.com/contest"
                  : "http://172.17.0.1:28888/contest";

              let container_runner: Docker.Container;
              if (queue_front.exposed) {
                const port = get_port(queue_front.room_id, exposed_ports);
                if (port === -1) {
                  console.log("no port available")
                  continue;
                }
                container_runner = await docker.createContainer({
                  Image: process.env.RUNNER_IMAGE,
                  AttachStdin: false,
                  AttachStdout: false,
                  AttachStderr: false,
                  name: `THUAI6_runner_${queue_front.room_id}`,
                  HostConfig: {
                    Binds: [
                      `${base_directory}/playback/${queue_front.room_id}/:/usr/local/playback`,
                      `${base_directory}/map/:/usr/local/map`,
                      `${base_directory}/${queue_front.team_id_1}/:/usr/local/team1`,
                      `${base_directory}/${queue_front.team_id_2}/:/usr/local/team2`
                    ],
                    PortBindings: {
                      '8888/tcp': [{HostPort: `${port}`}]
                    },
                    AutoRemove: true
                  },
                  ExposedPorts: {'8888/tcp': {}},
                  Env: [
                    `URL=${url}`,
                    `TOKEN=${serverToken}`,
                    `MODE=${queue_front.mode}`,
                    `MAP=${queue_front.map == 0 ? "oldmap.txt" : "newmap.txt"}`,
                    `EXPOSED=${queue_front.exposed}`,
                    `TIME=${process.env.GAME_TIME}`
                  ],
                  Cmd: [`-m 6g`]
                });

                await container_runner.start();
                console.log("runnner started");

                await client.request(
                  gql`
                    mutation update_room_port($room_id: uuid!, $port: Int, $contest_id: uuid){
                      update_contest_room(where: {_and: [{contest_id: {_eq: $contest_id}}, {room_id: {_eq: $room_id}}]}, _set: {port: $port}){
                        returning{
                          port
                        }
                      }
                    }
                  `,
                  {
                    contest_id: process.env.GAME_ID,
                    room_id: queue_front.room_id,
                    port: port,
                  }
                );
                container_runner.wait(async() => {
                  await client.request(
                    gql`
                      mutation update_room_port($room_id: uuid!, $port: Int, $contest_id: uuid){
                        update_contest_room(where: {_and: [{contest_id: {_eq: $contest_id}}, {room_id: {_eq: $room_id}}]}, _set: {port: $port}){
                          returning{
                            port
                          }
                        }
                      }
                    `,
                    {
                      contest_id: process.env.GAME_ID,
                      room_id: queue_front.room_id,
                      port: null,
                    }
                  );
                  const finish_path = base_directory + "/playback/" + queue_front.room_id;
                  fs.mkdir(finish_path, {recursive: true}, (err)=>{
                    if(err) throw err;
                    fs.writeFile(finish_path + "/finish.lock", "", (err)=>{
                      if(err) throw err;
                    })
                  });
                });
              }

              else {
                container_runner = await docker.createContainer({
                  Image: process.env.RUNNER_IMAGE,
                  AttachStdin: false,
                  AttachStdout: false,
                  AttachStderr: false,
                  name: `THUAI6_runner_${queue_front.room_id}`,
                  HostConfig: {
                    Binds: [
                      `${base_directory}/playback/${queue_front.room_id}/:/usr/local/playback`,
                      `${base_directory}/map/:/usr/local/map`,
                      `${base_directory}/${queue_front.team_id_1}/:/usr/local/team1`,
                      `${base_directory}/${queue_front.team_id_2}/:/usr/local/team2`
                    ],
                    AutoRemove: true
                  },
                  Env: [
                    `URL=${url}`,
                    `TOKEN=${serverToken}`,
                    `MODE=${queue_front.mode}`,
                    `MAP=${queue_front.map == 0 ? "oldmap.txt" : "newmap.txt"}`,
                    `EXPOSED=${queue_front.exposed}`,
                    `TIME=${process.env.GAME_TIME}`
                  ],
                  Cmd: [`-m 6g`]
                });

                await container_runner.start();
                console.log("runnner started");
              }

              setTimeout(() => {
                container_runner.stop(() => {
                  console.log("container forced to stop")
                });
              }, (process.env.GAME_TIME ? Number(process.env.GAME_TIME) : 600 + 5 * 60) * 1000);
            } catch (err) {
              console.log(err);
              continue;
            }
          }
        }
      }
    } catch (err) {
      console.log(err);
    }
  });
};

export default docker_cron;
